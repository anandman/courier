import { describe, expect, it } from 'vitest';

import {
    CliError,
    EXIT,
    EXIT_NAMES,
    describeExitCodes,
    isRetriable,
    needsHuman,
} from '../src/cli/exit.js';

/**
 * The exit code is the CLI's real interface: a consumer branches on the number
 * and never reads the prose. These tests exist so the contract cannot drift
 * without a deliberate edit here -- renumbering a code silently would break
 * every `case $?` written against it.
 */
describe('the exit-code contract', () => {
    it('gives every code a distinct number', () => {
        const codes = Object.values(EXIT);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('stays clear of the shell reserved range', () => {
        // 126, 127 and 128+N belong to the shell. A CLI that emitted 127 would
        // be indistinguishable from "command not found".
        for (const code of Object.values(EXIT)) {
            expect(code).toBeLessThan(126);
            expect(code).toBeGreaterThanOrEqual(0);
        }
    });

    it('pins the published numbers', () => {
        // Deliberately literal. If one of these needs to change, the change
        // should be visible in a diff rather than inferred from a helper.
        expect(EXIT).toEqual({
            OK: 0,
            INTERNAL: 1,
            USAGE: 2,
            NO_AUTH: 3,
            AUTH_REJECTED: 4,
            FORBIDDEN: 5,
            UNREACHABLE: 6,
            TOOL_ERROR: 7,
            UPSTREAM_AUTH: 8,
            INCOMPLETE: 9,
        });
    });

    it('names every code', () => {
        for (const code of Object.values(EXIT)) {
            expect(EXIT_NAMES[code]).toBeTypeOf('string');
            expect(EXIT_NAMES[code]).not.toBe('');
        }
    });

    it('describes every code, with a meaning', () => {
        const described = describeExitCodes();
        expect(described.map((entry) => entry.code)).toEqual(Object.values(EXIT).sort((a, b) => a - b));
        for (const entry of described) {
            expect(entry.meaning).not.toBe('');
        }
    });

    /**
     * Only a transport failure may be retried unchanged. Marking anything else
     * retriable would send a consumer into a loop against a revoked credential
     * or a malformed command, burning a rate limit while looking busy.
     */
    it('marks only unreachable as retriable', () => {
        expect(isRetriable(EXIT.UNREACHABLE)).toBe(true);
        for (const code of Object.values(EXIT)) {
            if (code !== EXIT.UNREACHABLE) expect(isRetriable(code)).toBe(false);
        }
    });

    it('marks the codes that need a person', () => {
        expect(needsHuman(EXIT.NO_AUTH)).toBe(true);
        expect(needsHuman(EXIT.AUTH_REJECTED)).toBe(true);
        expect(needsHuman(EXIT.UPSTREAM_AUTH)).toBe(true);
        expect(needsHuman(EXIT.OK)).toBe(false);
        expect(needsHuman(EXIT.UNREACHABLE)).toBe(false);
    });

    /**
     * Every code is emitted now. upstream-auth was reserved while nothing could
     * produce it -- the server had no way to say "the provider refused our
     * credential" apart from prose -- and a consumer waiting on it as a signal
     * would have waited forever. It is carried by a structured errorCode now.
     */
    it('emits every code it publishes', () => {
        for (const entry of describeExitCodes()) {
            expect(entry.emitted, entry.name).toBe(true);
        }
    });

    it('never reports success as retriable or needing a person', () => {
        expect(isRetriable(EXIT.OK)).toBe(false);
        expect(needsHuman(EXIT.OK)).toBe(false);
    });
});

describe('CliError', () => {
    it('carries its code and keeps the hint separate from the diagnosis', () => {
        const error = new CliError(EXIT.NO_AUTH, 'No credentials stored.', 'Run `courier auth login`.');

        expect(error.code).toBe(EXIT.NO_AUTH);
        expect(error.message).toBe('No credentials stored.');
        expect(error.hint).toBe('Run `courier auth login`.');
        // A hint concatenated into the message would end up in logs that parse
        // the message, and would read as part of the failure itself.
        expect(error.message).not.toContain('courier auth login');
    });
});
