/**
 * Where the CLI keeps what it learned about a server.
 *
 * Three different kinds of state share one file, keyed by server URL: the
 * client registration issued by `POST /register`, the tokens from the last
 * successful authorization, and the in-flight PKCE verifier. Keying by URL
 * matters because the same machine may legitimately talk to more than one
 * Courier -- a tailnet address and a loopback one during a migration are two
 * distinct authorization servers that issue non-interchangeable tokens.
 *
 * The registration is kept separately from the tokens, and on purpose: RFC 7591
 * gives a client no way to discover that its client_id has stopped being
 * recognised, and clients that re-register on every run accumulate dead
 * provisional entries on the server for a human to clean up. Registering once
 * and reusing the id is the behaviour the server's two-phase client store was
 * built to expect.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';

export interface ServerCredentials {
    client?: OAuthClientInformationFull;
    tokens?: OAuthTokens;
    /** When the stored tokens were issued, so `expires_in` can be turned into a wall-clock answer. */
    obtainedAt?: number;
    /** PKCE verifier, present only between the browser redirect and the code exchange. */
    codeVerifier?: string;
    /**
     * When the verifier stops being usable.
     *
     * A verifier with no expiry sits on disk forever as half of a usable PKCE
     * pair, and makes an abandoned login indistinguishable from a fresh one --
     * so a stale code pasted an hour later would be exchanged rather than
     * refused. Bounded to match the server's own authorization window: it
     * allows 10 minutes between /authorize and the upstream callback, and the
     * code it then issues lives 5 minutes, so a verifier outliving 10 minutes
     * can never be exchanged for anything regardless.
     */
    codeVerifierExpiresAt?: number;
    /**
     * The OAuth state parameter for a login in progress.
     *
     * Persisted rather than held in memory because a login can span two
     * invocations -- one to produce the URL, another to hand back the code --
     * and a state kept only in the first process could not be compared against
     * in the second. Cleared with the verifier once tokens are stored.
     */
    state?: string;
    /** Cached RFC 9728/8414 discovery, to spare the server two requests per invocation. */
    discovery?: OAuthDiscoveryState;
}

interface CredentialsFile {
    version: number;
    servers: Record<string, ServerCredentials>;
}

/**
 * The credentials file path.
 *
 * `COURIER_CLI_FILE` wins, then XDG. This is deliberately NOT the directory the
 * server keeps its vault in: the CLI's whole purpose is to run where the vault
 * does not, and pointing both at one path would invite a consumer to assume the
 * mail credentials are nearby.
 */
export function resolveCredentialsPath(): string {
    const explicit = process.env.COURIER_CLI_FILE?.trim();
    if (explicit) return explicit;

    const xdg = process.env.XDG_CONFIG_HOME?.trim();
    const base = xdg || join(homedir(), '.config');
    return join(base, 'courier', 'cli-credentials.json');
}

/**
 * Normalises a server URL into a storage key.
 *
 * Trailing slashes and default ports are noise -- `https://host/mcp` and
 * `https://host:443/mcp/` are the same server, and storing them apart would
 * strand a token behind a cosmetic difference in how the URL was typed.
 */
export function credentialKey(serverUrl: string | URL): string {
    const url = new URL(String(serverUrl));
    const path = url.pathname.endsWith('/') && url.pathname !== '/'
        ? url.pathname.slice(0, -1)
        : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
}

export class CredentialStore {
    private readonly filePath: string;
    private data: CredentialsFile | null = null;
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor(filePath = resolveCredentialsPath()) {
        this.filePath = filePath;
    }

    get path(): string {
        return this.filePath;
    }

    async read(serverUrl: string | URL): Promise<ServerCredentials> {
        const file = await this.load();
        return file.servers[credentialKey(serverUrl)] ?? {};
    }

    async update(
        serverUrl: string | URL,
        patch: (current: ServerCredentials) => ServerCredentials
    ): Promise<void> {
        const file = await this.load();
        const key = credentialKey(serverUrl);
        file.servers[key] = patch(file.servers[key] ?? {});
        await this.flush(file);
    }

    /** Forgets one server entirely. Returns false when there was nothing stored. */
    async forget(serverUrl: string | URL): Promise<boolean> {
        const file = await this.load();
        const key = credentialKey(serverUrl);
        if (!(key in file.servers)) return false;
        delete file.servers[key];
        await this.flush(file);
        return true;
    }

    async listServers(): Promise<string[]> {
        const file = await this.load();
        return Object.keys(file.servers).sort();
    }

    private async load(): Promise<CredentialsFile> {
        if (this.data) return this.data;

        try {
            const raw = await readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as CredentialsFile;
            this.data = { version: 1, servers: parsed.servers ?? {} };
        } catch (error) {
            // A missing file is the first run. A corrupt one is not silently
            // replaced: overwriting it would destroy a working refresh token
            // over what might be a half-finished write, and the fix (delete the
            // file, log in again) is one a human should choose.
            if (isMissing(error)) {
                this.data = { version: 1, servers: {} };
            } else if (error instanceof SyntaxError) {
                throw new Error(
                    `${this.filePath} is not valid JSON. Remove it and run \`courier auth login\` again to re-authorize.`
                );
            } else {
                throw error;
            }
        }

        return this.data;
    }

    private async flush(file: CredentialsFile): Promise<void> {
        const write = this.writeQueue.catch(() => undefined).then(() => this.writeFile(file));
        this.writeQueue = write.catch(() => undefined);
        await write;
    }

    private async writeFile(file: CredentialsFile): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

        try {
            // 0600 at creation, not after: a token must never exist on disk
            // world-readable, however briefly.
            await writeFile(tmpPath, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
            await rename(tmpPath, this.filePath);
            await chmod(this.filePath, 0o600).catch(() => undefined);
        } catch (error) {
            await unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }
}

/**
 * When the stored access token expires, or undefined when that cannot be known.
 *
 * Undefined is returned for a token with no `expires_in` rather than a
 * comfortable default: a guessed expiry would make `auth status` state
 * something it does not know.
 */
export function tokenExpiry(credentials: ServerCredentials): number | undefined {
    const expiresIn = credentials.tokens?.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return undefined;
    if (typeof credentials.obtainedAt !== 'number') return undefined;
    return credentials.obtainedAt + expiresIn * 1000;
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
