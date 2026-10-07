import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../src/cli/exit.js';
import { CliOAuthProvider, completeLogin, oobRedirectFor } from '../src/cli/oauth.js';
import { CredentialStore } from '../src/cli/store.js';

const SERVER = 'https://courier.example/mcp';

let dir: string;
let store: CredentialStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'courier-login-'));
    store = new CredentialStore(join(dir, 'cli-credentials.json'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function provider() {
    return new CliOAuthProvider({ serverUrl: SERVER, store });
}

describe('the PKCE verifier', () => {
    it('is stored with an expiry', async () => {
        const before = Date.now();
        await provider().saveCodeVerifier('verifier-value');

        const stored = await store.read(SERVER);
        expect(stored.codeVerifier).toBe('verifier-value');
        expect(stored.codeVerifierExpiresAt).toBeGreaterThan(before);
        // Matched to the server's 10-minute authorization window; a verifier
        // outliving it could not be exchanged for anything anyway.
        expect(stored.codeVerifierExpiresAt! - before).toBeLessThanOrEqual(10 * 60 * 1000 + 50);
    });

    it('comes back while it is still live', async () => {
        await provider().saveCodeVerifier('verifier-value');
        expect(await provider().codeVerifier()).toBe('verifier-value');
    });

    /**
     * Without an expiry a verifier sits on disk indefinitely as half of a live
     * PKCE pair, and an abandoned login looks identical to a fresh one -- so a
     * code pasted an hour later would be exchanged rather than refused.
     */
    it('is refused once the window has passed', async () => {
        await store.update(SERVER, (current) => ({
            ...current,
            codeVerifier: 'stale',
            codeVerifierExpiresAt: Date.now() - 1,
        }));

        try {
            await provider().codeVerifier();
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.AUTH_REJECTED);
            expect((error as CliError).message).toMatch(/expired/);
            expect((error as CliError).message).toMatch(/10 minutes/);
        }
    });

    it('is cleared when it expires, rather than left to be retried', async () => {
        await store.update(SERVER, (current) => ({
            ...current,
            codeVerifier: 'stale',
            codeVerifierExpiresAt: Date.now() - 1,
            state: 'stale-state',
        }));

        await provider().codeVerifier().catch(() => undefined);

        const stored = await store.read(SERVER);
        expect(stored.codeVerifier).toBeUndefined();
        expect(stored.codeVerifierExpiresAt).toBeUndefined();
        expect(stored.state).toBeUndefined();
    });

    it('says so when there was never one', async () => {
        try {
            await provider().codeVerifier();
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.AUTH_REJECTED);
            expect((error as CliError).message).toMatch(/No PKCE verifier/);
        }
    });

    it('is discarded once tokens are stored, not kept around', async () => {
        const instance = provider();
        await instance.saveCodeVerifier('verifier-value');
        await instance.saveTokens({ access_token: 'at', token_type: 'Bearer' });

        const stored = await store.read(SERVER);
        expect(stored.codeVerifier).toBeUndefined();
        expect(stored.codeVerifierExpiresAt).toBeUndefined();
        expect(stored.state).toBeUndefined();
        expect(stored.tokens?.access_token).toBe('at');
    });
});

describe('the OAuth state parameter', () => {
    /**
     * Persisted because a login can span two invocations: one produces the URL,
     * a later one hands back the code. A state kept only in the first process
     * could not be checked by the second, and skipping the check there would
     * quietly drop the one protection the parameter provides.
     */
    it('is persisted so a later invocation can check it', async () => {
        const first = provider();
        const issued = await first.state();

        expect(await first.storedState()).toBe(issued);
        expect(await provider().storedState()).toBe(issued);
    });

    it('stays the same within one attempt', async () => {
        const instance = provider();
        expect(await instance.state()).toBe(await instance.state());
    });
});

describe('finishing a login with a pasted redirect', () => {
    beforeEach(async () => {
        await store.update(SERVER, (current) => ({
            ...current,
            codeVerifier: 'verifier-value',
            codeVerifierExpiresAt: Date.now() + 60_000,
            state: 'the-right-state',
        }));
    });

    const log = () => undefined;

    it('refuses a redirect from a different login attempt', async () => {
        // Two logins started in different terminals, and the code from one
        // pasted into the other: it would exchange against the wrong verifier
        // and fail with something far less useful than this.
        try {
            await completeLogin({
                serverUrl: SERVER,
                store,
                log,
                code: 'http://127.0.0.1/callback?code=abc&state=a-different-state',
            });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.AUTH_REJECTED);
            expect((error as CliError).message).toMatch(/different login attempt/);
        }
    });

    it('surfaces an error carried in the redirect', async () => {
        try {
            await completeLogin({
                serverUrl: SERVER,
                store,
                log,
                code: 'http://127.0.0.1/callback?error=access_denied&error_description=Not%20permitted',
            });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.AUTH_REJECTED);
            expect((error as CliError).message).toMatch(/access_denied/);
            expect((error as CliError).message).toMatch(/Not permitted/);
        }
    });

    it('rejects a URL with no code in it', async () => {
        await expect(
            completeLogin({ serverUrl: SERVER, store, log, code: 'http://127.0.0.1/callback' })
        ).rejects.toThrow(/no authorization code/);
    });

    it('rejects an empty paste', async () => {
        await expect(
            completeLogin({ serverUrl: SERVER, store, log, code: '   ' })
        ).rejects.toThrow(/needs the redirect URL/);
    });

    it('refuses when no login is in progress', async () => {
        const empty = new CredentialStore(join(dir, 'other.json'));

        try {
            await completeLogin({
                serverUrl: SERVER,
                store: empty,
                log,
                code: 'http://127.0.0.1/callback?code=abc',
            });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.AUTH_REJECTED);
            expect((error as CliError).message).toMatch(/No login is in progress/);
        }
    });
});

describe('where the browser is sent', () => {
    it("derives Courier's code page from the MCP endpoint's origin", () => {
        // Courier is its own authorization server -- it owns registration and
        // issues its own tokens -- so the page is served from its origin.
        expect(oobRedirectFor('https://courier.example/mcp')).toBe('https://courier.example/auth/oob');
        expect(oobRedirectFor('https://courier.example:10000/mcp')).toBe(
            'https://courier.example:10000/auth/oob'
        );
        expect(oobRedirectFor('http://127.0.0.1:3333/mcp')).toBe('http://127.0.0.1:3333/auth/oob');
    });

    it('registers both the code page and a loopback target', async () => {
        const metadata = provider().clientMetadata;

        expect(metadata.redirect_uris).toContain('https://courier.example/auth/oob');
        expect(metadata.redirect_uris).toContain('http://127.0.0.1/callback');
        // A public client: a secret shipped to every machine running a CLI is
        // not a secret, and PKCE is what binds a code to the process.
        expect(metadata.token_endpoint_auth_method).toBe('none');
    });

    it('defaults to the code page, which works wherever the browser is', () => {
        expect(provider().redirectUrl).toBe('https://courier.example/auth/oob');
    });

    it('uses a loopback target once one is bound', () => {
        const instance = provider();
        instance.setRedirectUrl('http://127.0.0.1:45557/callback');

        expect(instance.redirectUrl).toBe('http://127.0.0.1:45557/callback');
    });
});

describe('a registration that predates a redirect target', () => {
    /**
     * RFC 7591 gives a client no way to amend its own registration, and the
     * SDK's server implements no update endpoint. A stored client missing one
     * of the two redirect URIs would have its authorization request refused
     * with "Unregistered redirect_uri", which says nothing about the cause --
     * so it is treated as absent and the next login registers afresh.
     */
    it('is treated as absent, so a fresh one is obtained', async () => {
        await store.update(SERVER, (current) => ({
            ...current,
            client: {
                client_id: 'old-client',
                redirect_uris: ['http://127.0.0.1/callback'],
            } as never,
        }));

        expect(await provider().clientInformation()).toBeUndefined();
    });

    it('is kept when it covers both targets', async () => {
        await store.update(SERVER, (current) => ({
            ...current,
            client: {
                client_id: 'current-client',
                redirect_uris: ['https://courier.example/auth/oob', 'http://127.0.0.1/callback'],
            } as never,
        }));

        expect((await provider().clientInformation())?.client_id).toBe('current-client');
    });
});
