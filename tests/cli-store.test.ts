import { stat } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialStore, credentialKey, resolveCredentialsPath, tokenExpiry } from '../src/cli/store.js';

let dir: string;
let store: CredentialStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'courier-cli-'));
    store = new CredentialStore(join(dir, 'cli-credentials.json'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const tokens = { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 };

describe('keying by server', () => {
    it('treats cosmetic URL differences as the same server', () => {
        // A token stranded behind a trailing slash is a token the user will be
        // told to re-obtain for no reason.
        expect(credentialKey('https://host/mcp/')).toBe(credentialKey('https://host/mcp'));
        expect(credentialKey('https://host:443/mcp')).toBe(credentialKey('https://host/mcp'));
    });

    it('keeps genuinely different servers apart', () => {
        expect(credentialKey('https://host/mcp')).not.toBe(credentialKey('https://other/mcp'));
        expect(credentialKey('https://host/mcp')).not.toBe(credentialKey('https://host/other'));
        expect(credentialKey('https://host/mcp')).not.toBe(credentialKey('http://host/mcp'));
    });

    it('keeps a non-default port distinct', () => {
        expect(credentialKey('https://host:10000/mcp')).not.toBe(credentialKey('https://host/mcp'));
    });
});

describe('storing credentials', () => {
    it('round-trips tokens for a server', async () => {
        await store.update('https://host/mcp', (current) => ({ ...current, tokens, obtainedAt: 1000 }));

        expect(await store.read('https://host/mcp')).toMatchObject({ tokens, obtainedAt: 1000 });
        expect(await store.read('https://host/mcp/')).toMatchObject({ tokens });
    });

    it('returns an empty record for a server it has never seen', async () => {
        expect(await store.read('https://unknown/mcp')).toEqual({});
    });

    it('keeps the file readable only by its owner', async () => {
        await store.update('https://host/mcp', (current) => ({ ...current, tokens }));

        const stats = await stat(join(dir, 'cli-credentials.json'));
        expect(stats.mode & 0o777).toBe(0o600);
    });

    it('survives a restart', async () => {
        await store.update('https://host/mcp', (current) => ({ ...current, tokens }));

        const reopened = new CredentialStore(join(dir, 'cli-credentials.json'));
        expect((await reopened.read('https://host/mcp')).tokens).toEqual(tokens);
    });

    it('lists the servers it holds', async () => {
        await store.update('https://b/mcp', (current) => ({ ...current, tokens }));
        await store.update('https://a/mcp', (current) => ({ ...current, tokens }));

        expect(await store.listServers()).toEqual(['https://a/mcp', 'https://b/mcp']);
    });

    it('forgets one server without disturbing another', async () => {
        await store.update('https://a/mcp', (current) => ({ ...current, tokens }));
        await store.update('https://b/mcp', (current) => ({ ...current, tokens }));

        expect(await store.forget('https://a/mcp')).toBe(true);
        expect(await store.listServers()).toEqual(['https://b/mcp']);
    });

    it('reports that there was nothing to forget', async () => {
        expect(await store.forget('https://nothing/mcp')).toBe(false);
    });

    /**
     * Replacing a file that failed to parse would destroy a working refresh
     * token over what might be a half-finished write. Refusing costs the user
     * one deliberate deletion and cannot lose anything.
     */
    it('refuses to silently replace a corrupt file', async () => {
        const path = join(dir, 'corrupt.json');
        await writeFile(path, '{ not json');

        await expect(new CredentialStore(path).read('https://host/mcp')).rejects.toThrow(/not valid JSON/);
    });
});

describe('token expiry', () => {
    it('reports when the access token runs out', () => {
        const expiry = tokenExpiry({ tokens, obtainedAt: 1_000_000 });
        expect(expiry).toBe(1_000_000 + 3600 * 1000);
    });

    /**
     * Undefined, not a default. A guessed expiry would make `auth status`
     * state something it does not know, which is the same class of mistake as
     * a page size reported as a total.
     */
    it('declines to guess when the server did not say', () => {
        expect(tokenExpiry({ tokens: { access_token: 'at', token_type: 'Bearer' }, obtainedAt: 1 })).toBeUndefined();
        expect(tokenExpiry({ tokens })).toBeUndefined();
        expect(tokenExpiry({})).toBeUndefined();
    });
});

describe('where credentials live', () => {
    it('honours an explicit path', () => {
        const previous = process.env.COURIER_CLI_FILE;
        process.env.COURIER_CLI_FILE = '/tmp/explicit.json';
        try {
            expect(resolveCredentialsPath()).toBe('/tmp/explicit.json');
        } finally {
            if (previous === undefined) delete process.env.COURIER_CLI_FILE;
            else process.env.COURIER_CLI_FILE = previous;
        }
    });

    it('otherwise lives under the config directory', () => {
        const previousFile = process.env.COURIER_CLI_FILE;
        const previousXdg = process.env.XDG_CONFIG_HOME;
        delete process.env.COURIER_CLI_FILE;
        process.env.XDG_CONFIG_HOME = '/home/someone/.config';
        try {
            expect(resolveCredentialsPath()).toBe('/home/someone/.config/courier/cli-credentials.json');
        } finally {
            if (previousFile !== undefined) process.env.COURIER_CLI_FILE = previousFile;
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousXdg;
        }
    });
});
