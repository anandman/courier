import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CourierClientStore } from '../src/auth/client-store.js';
import { renderUiPage } from '../src/ui.js';

let dir: string;
let store: CourierClientStore;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'courier-clients-'));
    store = new CourierClientStore({ filePath: join(dir, 'oauth-clients.json') });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function register(clientId: string, name?: string) {
    return store.registerClient({
        client_id: clientId,
        client_name: name,
        redirect_uris: ['https://client.example/callback'],
    } as never);
}

describe('client ownership', () => {
    it('records the authorizing user when a client is promoted', async () => {
        await register('c1', 'ChatGPT');
        await store.promoteClient('c1', 'anand@example.com');

        const mine = await store.listClientsForOwner('anand@example.com');
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ clientId: 'c1', clientName: 'ChatGPT' });
        expect(mine[0].promotedAt).toBeTypeOf('number');
    });

    it('does not show one user the clients of another', async () => {
        await register('mine', 'Codex');
        await register('theirs', 'Claude');
        await store.promoteClient('mine', 'anand@example.com');
        await store.promoteClient('theirs', 'partner@example.com');

        expect((await store.listClientsForOwner('anand@example.com')).map((c) => c.clientId)).toEqual([
            'mine',
        ]);
        expect(
            (await store.listClientsForOwner('partner@example.com')).map((c) => c.clientId)
        ).toEqual(['theirs']);
    });

    it('omits provisional clients, which nobody has authorized yet', async () => {
        await register('unpromoted', 'Drive-by');

        expect(await store.listClientsForOwner('anand@example.com')).toEqual([]);
        expect(await store.listUnattributedClients()).toEqual([]);
    });

    it('reports pre-ownership clients separately rather than guessing an owner', async () => {
        await register('legacy', 'Old client');
        await store.promoteClient('legacy');

        expect(await store.listClientsForOwner('anand@example.com')).toEqual([]);
        const orphans = await store.listUnattributedClients();
        expect(orphans.map((c) => c.clientId)).toEqual(['legacy']);
    });

    it('attributes a legacy client once its owner authorizes it again', async () => {
        await register('legacy', 'Old client');
        await store.promoteClient('legacy');
        await store.promoteClient('legacy', 'anand@example.com');

        expect(await store.listUnattributedClients()).toEqual([]);
        expect((await store.listClientsForOwner('anand@example.com')).map((c) => c.clientId)).toEqual(
            ['legacy']
        );
    });
});

describe('revocation', () => {
    it('removes a client the user owns', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');

        expect(await store.deleteClient('c1', 'anand@example.com')).toBe(true);
        expect(await store.getClient('c1')).toBeUndefined();
    });

    it("refuses to remove another user's client", async () => {
        await register('theirs');
        await store.promoteClient('theirs', 'partner@example.com');

        expect(await store.deleteClient('theirs', 'anand@example.com')).toBe(false);
        expect(await store.getClient('theirs')).toBeDefined();
    });

    it('allows anyone to clear an unattributed client', async () => {
        // Nobody can prove ownership of these, and leaving them permanently
        // unrevocable would be worse than letting an allowlisted user clear them.
        await register('legacy');
        await store.promoteClient('legacy');

        expect(await store.deleteClient('legacy', 'anand@example.com')).toBe(true);
    });

    it('reports failure for a client that does not exist', async () => {
        expect(await store.deleteClient('ghost', 'anand@example.com')).toBe(false);
    });

    it('survives a restart', async () => {
        await register('c1', 'Codex');
        await store.promoteClient('c1', 'anand@example.com');

        const reopened = new CourierClientStore({ filePath: join(dir, 'oauth-clients.json') });
        expect((await reopened.listClientsForOwner('anand@example.com')).map((c) => c.clientId)).toEqual(
            ['c1']
        );
    });
});

describe('liveness stamps', () => {
    it('records last use for a promoted client', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');
        await store.touchClient('c1');

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.lastSeenAt).toBeTypeOf('number');
    });

    it('ignores provisional clients', async () => {
        await register('provisional');
        await store.touchClient('provisional');

        expect(await store.listUnattributedClients()).toEqual([]);
    });
});

describe('client list UI', () => {
    const user = { userId: 'anand@example.com', email: 'anand@example.com' };

    it('lists a client with a revoke control', () => {
        const html = renderUiPage(user, [], null, null, [
            { clientId: 'c1', clientName: 'ChatGPT', promotedAt: Date.now() - 3600_000 },
        ]);

        expect(html).toContain('ChatGPT');
        expect(html).toContain('/ui/clients/revoke');
        expect(html).toContain('value="c1"');
        expect(html).toContain('1 hour ago');
    });

    it('flags unattributed clients rather than presenting them as the user’s own', () => {
        const html = renderUiPage(user, [], null, null, [], [
            { clientId: 'legacy', clientName: 'Old client' },
        ]);

        expect(html).toContain('Authorized before ownership was recorded');
        expect(html).toContain('Old client');
    });

    it('says so when nothing is authorized', () => {
        expect(renderUiPage(user, [], null, null, [], [])).toContain('No clients authorized yet');
    });

    it('escapes client names', () => {
        const html = renderUiPage(user, [], null, null, [
            { clientId: 'x', clientName: '<img src=x onerror=alert(1)>' },
        ]);

        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });
});

describe('recording which machine a client runs on', () => {
    /**
     * Five permanent clients are named "Claude Code", "Codex", "Open WebUI" --
     * software that runs on more than one machine. The name alone cannot answer
     * "which client, on which machine", and this deployment has clients on at
     * least three.
     */
    it('remembers where a client was last seen', async () => {
        await register('c1', 'Codex');
        await store.promoteClient('c1', 'anand@example.com');

        await store.touchClient('c1', '100.64.0.2');

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.lastSeenFrom).toBe('100.64.0.2');
    });

    it('updates when the same client appears from a different machine', async () => {
        // The rate limit on last-seen writes must not hide a client moving, or
        // the field answers the wrong question the moment it matters.
        await register('c1', 'Codex');
        await store.promoteClient('c1', 'anand@example.com');

        await store.touchClient('c1', '100.64.0.1');
        await store.touchClient('c1', '100.64.0.2');

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.lastSeenFrom).toBe('100.64.0.2');
    });

    it('keeps the last known source when a request carries none', async () => {
        await register('c1', 'Codex');
        await store.promoteClient('c1', 'anand@example.com');

        await store.touchClient('c1', '100.64.0.2');
        await store.touchClient('c1', undefined);

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.lastSeenFrom).toBe('100.64.0.2');
    });

    it('shows the machine in the settings UI', async () => {
        await register('c1', 'Codex');
        await store.promoteClient('c1', 'anand@example.com');
        await store.touchClient('c1', '100.64.0.2');

        const html = renderUiPage(
            { userId: 'anand@example.com', email: 'anand@example.com' },
            [],
            null,
            null,
            await store.listClientsForOwner('anand@example.com')
        );

        expect(html).toContain('100.64.0.2');
    });
});

describe('per-client permissions', () => {
    it('reports no overrides for a promoted client that has none', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');

        expect(await store.policyFor('c1')).toEqual({});
    });

    /**
     * Undefined and empty are different answers and must stay so. An unknown
     * client has no policy because it does not exist; a known one with no
     * overrides runs on defaults. Collapsing them would let a revoked client's
     * calls be judged against defaults rather than refused.
     */
    it('reports undefined for a client it does not know', async () => {
        expect(await store.policyFor('ghost')).toBeUndefined();
    });

    it('stores a tier for one tool', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');

        expect(await store.setToolTier('c1', 'send_email', 'allow')).toBe(true);
        expect(await store.policyFor('c1')).toEqual({ send_email: 'allow' });
    });

    it('keeps each client separate', async () => {
        await register('a');
        await register('b');
        await store.promoteClient('a', 'anand@example.com');
        await store.promoteClient('b', 'anand@example.com');

        await store.setToolTier('a', 'send_email', 'allow');

        expect(await store.policyFor('a')).toEqual({ send_email: 'allow' });
        expect(await store.policyFor('b')).toEqual({});
    });

    it('clears a tier back to the default', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');
        await store.setToolTier('c1', 'send_email', 'allow');

        expect(await store.setToolTier('c1', 'send_email', null)).toBe(true);
        expect(await store.policyFor('c1')).toEqual({});
    });

    /**
     * Only deliberate choices are stored, so revising a default later actually
     * reaches existing clients -- and the UI can tell a decision from an
     * inherited value.
     */
    it('stores nothing for a client left entirely on defaults', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');
        await store.setToolTier('c1', 'send_email', 'allow');
        await store.setToolTier('c1', 'send_email', null);

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.policy).toBeUndefined();
    });

    /**
     * Registration is anonymous by RFC 7591, so attaching permissions to a
     * provisional entry would let anyone on the internet create policy rows.
     */
    it('refuses to set a tier on a client nobody has authorized', async () => {
        await register('provisional');

        expect(await store.setToolTier('provisional', 'send_email', 'allow')).toBe(false);
        expect(await store.policyFor('provisional')).toEqual({});
    });

    it('refuses a tier that is not one of the three', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');

        expect(await store.setToolTier('c1', 'send_email', 'maybe' as never)).toBe(false);
        expect(await store.policyFor('c1')).toEqual({});
    });

    it('survives a restart', async () => {
        await register('c1');
        await store.promoteClient('c1', 'anand@example.com');
        await store.setToolTier('c1', 'delete_emails', 'deny');

        const reopened = new CourierClientStore({ filePath: join(dir, 'oauth-clients.json') });
        expect(await reopened.policyFor('c1')).toEqual({ delete_emails: 'deny' });
    });

    it('is reported alongside the client in the settings list', async () => {
        await register('c1', 'ChatGPT');
        await store.promoteClient('c1', 'anand@example.com');
        await store.setToolTier('c1', 'send_email', 'allow');

        const [client] = await store.listClientsForOwner('anand@example.com');
        expect(client.policy).toEqual({ send_email: 'allow' });
    });
});
