import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Two-phase client registry.
 *
 * `POST /register` is unauthenticated by RFC 7591, so anyone on the internet can
 * call it. New registrations are therefore provisional: they carry a TTL, they
 * count against a hard cap, and the oldest is evicted once that cap is reached.
 * A client becomes permanent only once an allowlisted human has completed an
 * authorization with it, and permanent entries never expire and are never
 * evicted. Anonymous traffic can consume at most `maxProvisional` slots.
 *
 * Provisional entries are persisted rather than held in memory. Clients cache
 * the `client_id` they were issued and do not re-register when it stops being
 * recognised, so a restart between registration and first authorization would
 * otherwise break a client permanently. The cap is what bounds disk use here;
 * keeping them in memory only bought durability problems, not safety.
 */
export interface CourierClientStoreOptions {
    filePath: string;
    provisionalTtlMs?: number;
    maxProvisional?: number;
}

/** `expiresAt: null` marks a promoted client: permanent, never evicted. */
interface StoredClient {
    client: OAuthClientInformationFull;
    expiresAt: number | null;
    /**
     * The user who authorized this client. Absent on provisional entries (no
     * one has authorized them yet) and on entries promoted before ownership was
     * recorded, which the UI surfaces separately rather than misattributing.
     */
    ownerId?: string;
    registeredAt?: number;
    promotedAt?: number;
    /** Last time this client presented a valid access token. */
    lastSeenAt?: number;
}

/** A promoted client with the metadata the settings UI needs to describe it. */
export interface AuthorizedClient {
    clientId: string;
    clientName?: string;
    ownerId?: string;
    registeredAt?: number;
    promotedAt?: number;
    lastSeenAt?: number;
}

interface ClientFileData {
    version: number;
    clients: Record<string, StoredClient>;
}

/**
 * How long a registration survives before anyone has authorized it.
 *
 * This was 30 minutes, which quietly orphans clients. A client registers, the
 * user gets distracted, and half an hour later the registration is gone -- but
 * the client cached its client_id and, per RFC 7591, has no reason to ever
 * register again. It presents a dead id forever and the only cure is removing
 * and re-adding the server by hand. Nothing in the log says why.
 *
 * The TTL was never what bounded disk use anyway: `maxProvisional` is, by
 * evicting oldest-first when the cap is reached. A day gives a real person time
 * to finish signing in, and a flood is still capped at 500 entries that promoted
 * clients are never displaced by.
 */
const DEFAULT_PROVISIONAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PROVISIONAL = 500;
/** How stale a lastSeenAt stamp must be before a request rewrites the store. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

export class CourierClientStore implements OAuthRegisteredClientsStore {
    private readonly filePath: string;
    private readonly provisionalTtlMs: number;
    private readonly maxProvisional: number;
    private clients: Map<string, StoredClient> | null = null;
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor(options: CourierClientStoreOptions) {
        this.filePath = options.filePath;
        this.provisionalTtlMs = options.provisionalTtlMs ?? DEFAULT_PROVISIONAL_TTL_MS;
        this.maxProvisional = options.maxProvisional ?? DEFAULT_MAX_PROVISIONAL;
    }

    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
        const clients = await this.load();
        const entry = clients.get(clientId);
        if (!entry) return undefined;

        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            clients.delete(clientId);
            await this.flush(clients);
            // Say so. A client whose registration expired keeps presenting the
            // same client_id and never re-registers, so this is the moment that
            // explains every later failure -- and it used to leave no trace at
            // all, which made an orphaned client indistinguishable from one that
            // had never connected.
            console.warn(
                `[auth] registration expired for ${clientId}` +
                    ` (never authorized; registered clients expire after ${Math.round(this.provisionalTtlMs / 3600000)}h)`
            );
            return undefined;
        }

        return entry.client;
    }

    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
        const clients = await this.load();
        this.pruneExpired(clients);

        // Evict the oldest provisional entry rather than rejecting, so a flood
        // degrades into retries for legitimate clients instead of a hard outage.
        // Promoted clients are skipped: a flood must never displace one.
        while (this.countProvisional(clients) >= this.maxProvisional) {
            const oldest = [...clients.entries()]
                .filter(([, entry]) => entry.expiresAt !== null)
                .sort((a, b) => (a[1].expiresAt ?? 0) - (b[1].expiresAt ?? 0))[0];
            if (!oldest) break;
            clients.delete(oldest[0]);
            // Eviction orphans that client permanently, same as expiry. It only
            // happens under a flood, which is exactly when nobody is watching,
            // so leave evidence.
            console.warn(
                `[auth] evicted registration ${oldest[0]} to make room` +
                    ` (provisional cap ${this.maxProvisional} reached)`
            );
        }

        const clientId = client.client_id || randomUUID();
        const registered: OAuthClientInformationFull = { ...client, client_id: clientId };
        const now = Date.now();
        clients.set(clientId, {
            client: registered,
            expiresAt: now + this.provisionalTtlMs,
            registeredAt: now,
        });
        await this.flush(clients);

        return registered;
    }

    /**
     * Marks a client permanent and records who authorized it. Called only after
     * an allowlisted user has completed an authorization code exchange.
     *
     * Ownership is recorded here because this is the only moment Courier knows
     * both the client and the human: registration is anonymous by RFC 7591, and
     * a bearer token afterwards proves only that *someone* holds it.
     */
    async promoteClient(clientId: string, ownerId?: string): Promise<void> {
        const clients = await this.load();
        const entry = clients.get(clientId);
        if (!entry) return;
        // Re-authorizing an already-promoted client is how a legacy entry with
        // no recorded owner acquires one, so this must not return early.
        if (entry.expiresAt === null && entry.ownerId === ownerId) return;

        clients.set(clientId, {
            ...entry,
            expiresAt: null,
            ownerId: ownerId ?? entry.ownerId,
            promotedAt: entry.promotedAt ?? Date.now(),
        });
        await this.flush(clients);
    }

    /**
     * Promoted clients this user authorized. Clients promoted before ownership
     * was recorded have no owner and are returned by `listUnattributedClients`
     * instead -- attributing them to whoever happens to ask would be a guess.
     */
    async listClientsForOwner(ownerId: string): Promise<AuthorizedClient[]> {
        return this.describe((entry) => entry.expiresAt === null && entry.ownerId === ownerId);
    }

    async listUnattributedClients(): Promise<AuthorizedClient[]> {
        return this.describe((entry) => entry.expiresAt === null && entry.ownerId === undefined);
    }

    /**
     * Removes a client. Refuses if it belongs to someone else, so one user
     * cannot revoke another's client by guessing an id.
     *
     * Deleting the record is not by itself full revocation: the client's
     * refresh grant dies immediately (the token endpoint looks the client up),
     * but a self-contained access token stays cryptographically valid until it
     * expires. `verifyAccessToken` closes that window by checking the client
     * still exists on every request.
     */
    async deleteClient(clientId: string, ownerId: string): Promise<boolean> {
        const clients = await this.load();
        const entry = clients.get(clientId);
        if (!entry || entry.expiresAt !== null) return false;
        if (entry.ownerId !== undefined && entry.ownerId !== ownerId) return false;

        clients.delete(clientId);
        await this.flush(clients);
        return true;
    }

    /** Records that a client is still in use. Best-effort: never blocks a request. */
    async touchClient(clientId: string): Promise<void> {
        const clients = await this.load();
        const entry = clients.get(clientId);
        if (!entry || entry.expiresAt !== null) return;

        // Only write when the stamp is meaningfully stale. A busy client would
        // otherwise rewrite the whole store on every single request.
        const now = Date.now();
        if (entry.lastSeenAt !== undefined && now - entry.lastSeenAt < LAST_SEEN_RESOLUTION_MS) return;

        clients.set(clientId, { ...entry, lastSeenAt: now });
        await this.flush(clients);
    }

    private async describe(
        predicate: (entry: StoredClient) => boolean
    ): Promise<AuthorizedClient[]> {
        const clients = await this.load();
        return [...clients.entries()]
            .filter(([, entry]) => predicate(entry))
            .map(([clientId, entry]) => ({
                clientId,
                clientName: entry.client.client_name,
                ownerId: entry.ownerId,
                registeredAt: entry.registeredAt,
                promotedAt: entry.promotedAt,
                lastSeenAt: entry.lastSeenAt,
            }))
            .sort((a, b) => (b.lastSeenAt ?? b.promotedAt ?? 0) - (a.lastSeenAt ?? a.promotedAt ?? 0));
    }

    private countProvisional(clients: Map<string, StoredClient>): number {
        let count = 0;
        for (const entry of clients.values()) {
            if (entry.expiresAt !== null) count += 1;
        }
        return count;
    }

    private pruneExpired(clients: Map<string, StoredClient>): void {
        const now = Date.now();
        for (const [clientId, entry] of clients) {
            if (entry.expiresAt !== null && entry.expiresAt <= now) {
                clients.delete(clientId);
            }
        }
    }

    private async load(): Promise<Map<string, StoredClient>> {
        if (this.clients) return this.clients;

        try {
            const raw = await readFile(this.filePath, 'utf8');
            const data = JSON.parse(raw) as ClientFileData;
            this.clients = new Map(Object.entries(data.clients ?? {}));
        } catch (error) {
            if (isNodeError(error) && error.code !== 'ENOENT') throw error;
            this.clients = new Map();
        }

        return this.clients;
    }

    private async flush(clients: Map<string, StoredClient>): Promise<void> {
        const data: ClientFileData = { version: 2, clients: Object.fromEntries(clients) };
        const write = this.writeQueue.catch(() => undefined).then(() => this.writeFile(data));
        this.writeQueue = write.catch(() => undefined);
        await write;
    }

    private async writeFile(data: ClientFileData): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

        try {
            await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
            await rename(tmpPath, this.filePath);
            await chmod(this.filePath, 0o600).catch(() => undefined);
        } catch (error) {
            await unlink(tmpPath).catch(() => undefined);
            throw error;
        }
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
