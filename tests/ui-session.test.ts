/**
 * Browser-session integrity: the signing-secret floor, and revocation.
 *
 * Both gaps were found while describing this module to another project. The
 * session cookie is a self-contained signature with a seven-day lifetime and no
 * server-side record, which makes two things load-bearing that were not
 * enforced: the secret has to be strong, and the allowlist has to be consulted
 * on the read path rather than once at login.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';

import {
    MIN_SESSION_SECRET_LENGTH,
    assertUsableSessionSecret,
    signSession,
    verifySession,
} from '../src/auth/session.js';
import { resolveUiUser } from '../src/index.js';

const STRONG = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);
const WEAK = 'hunter2';

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('session signing secret', () => {
    it('matches the floor TokenService enforces on MCP tokens', () => {
        expect(MIN_SESSION_SECRET_LENGTH).toBe(32);
    });

    it('refuses to sign with a weak secret', () => {
        // Previously this signed happily: createHmac accepts any key length, so
        // the only symptom was that sessions were forgeable.
        expect(() => signSession({ sub: 'a@example.com', exp: future() }, WEAK)).toThrow(
            /at least 32 characters/
        );
    });

    it('names the length it got and how to generate one', () => {
        expect(() => assertUsableSessionSecret(WEAK)).toThrow(/got 7/);
        expect(() => assertUsableSessionSecret(WEAK)).toThrow(/openssl rand -hex 32/);
    });

    it('accepts a secret exactly at the floor', () => {
        expect(() => assertUsableSessionSecret(STRONG)).not.toThrow();
    });

    it('verifies nothing against a weak secret rather than throwing', () => {
        // Fail closed, but do not throw: a misconfiguration should present as a
        // login prompt, not a 500 on every page.
        expect(verifySession('anything.at.all', WEAK)).toBeNull();
    });

    it('still round-trips a session signed with a strong secret', () => {
        const token = signSession({ sub: 'a@example.com', email: 'a@example.com', exp: future() }, STRONG);

        expect(verifySession(token, STRONG)?.sub).toBe('a@example.com');
    });

    it('rejects a session signed with a different secret', () => {
        const token = signSession({ sub: 'a@example.com', exp: future() }, STRONG);

        expect(verifySession(token, 'b'.repeat(MIN_SESSION_SECRET_LENGTH))).toBeNull();
    });

    it('rejects an expired session', () => {
        const token = signSession({ sub: 'a@example.com', exp: Math.floor(Date.now() / 1000) - 1 }, STRONG);

        expect(verifySession(token, STRONG)).toBeNull();
    });
});

describe('allowlist re-check on every request', () => {
    const request = (cookie?: string) =>
        ({ headers: cookie ? { cookie } : {} }) as unknown as express.Request;

    const withSession = (sub: string) =>
        request(`fm_session=${encodeURIComponent(signSession({ sub, exp: future() }, STRONG))}`);

    let original: string | undefined;

    beforeEach(() => {
        original = process.env.MCP_UI_SESSION_SECRET;
        process.env.MCP_UI_SESSION_SECRET = STRONG;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        if (original === undefined) delete process.env.MCP_UI_SESSION_SECRET;
        else process.env.MCP_UI_SESSION_SECRET = original;
        vi.restoreAllMocks();
    });

    it('admits a user who is still on the allowlist', () => {
        const allowed = new Set(['a@example.com']);

        expect(resolveUiUser(withSession('a@example.com'), 'oidc', allowed)?.userId).toBe(
            'a@example.com'
        );
    });

    it('rejects a still-valid cookie once its user is removed', () => {
        // The actual defect. The signature is good and the session has six more
        // days to run; only the allowlist changed, and that used to be invisible
        // until expiry.
        const token = withSession('gone@example.com');

        expect(resolveUiUser(token, 'oidc', new Set(['a@example.com']))).toBeNull();
    });

    it('says so in the log, since nothing else marks the moment', () => {
        resolveUiUser(withSession('gone@example.com'), 'oidc', new Set(['a@example.com']));

        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('gone@example.com'));
    });

    it('compares case-insensitively, as parseAllowedUsers lowercases entries', () => {
        expect(resolveUiUser(withSession('A@Example.com'), 'oidc', new Set(['a@example.com']))).not
            .toBeNull();
    });

    it('admits everyone when no allowlist is configured', () => {
        // Fail-open here is deliberate and narrow: assertAccessIsRestricted
        // already refuses to start oidc mode without an allowlist, so an absent
        // set means a mode that never had one.
        expect(resolveUiUser(withSession('anyone@example.com'), 'oidc', undefined)?.userId).toBe(
            'anyone@example.com'
        );
    });

    it('returns null without a cookie', () => {
        expect(resolveUiUser(request(), 'oidc', new Set(['a@example.com']))).toBeNull();
    });

    it('returns null for a forged cookie', () => {
        expect(
            resolveUiUser(request('fm_session=not.a.real.token'), 'oidc', new Set(['a@example.com']))
        ).toBeNull();
    });
});
