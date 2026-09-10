/**
 * Incremental mail changes.
 *
 * Replaces a 24-search poll (~48 HTTP requests, since each search is a query
 * then a get) with one request. The failure modes all share a shape: a delta
 * feed that looks healthy while silently no longer tracking the mailbox.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { changesSince, changesSinceSchema } from '../src/tools/changes.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [
        {
            name: 'personal@example.com',
            displayName: 'Personal',
            token: 'personal-token',
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        },
    ],
    defaultAccount: 'personal@example.com',
};

const INBOX = 'mbx-inbox';
const SENT = 'mbx-sent';
const ARCHIVE = 'mbx-archive';

const email = (id: string, mailboxIds: string[], keywords: Record<string, boolean> = {}) => ({
    id,
    threadId: `T-${id}`,
    mailboxIds: Object.fromEntries(mailboxIds.map((m) => [m, true])),
    keywords,
    messageId: [`${id}@example.com`],
    inReplyTo: null,
    references: null,
    subject: `Message ${id}`,
    from: [{ name: null, email: 'sender@example.com' }],
    to: [{ name: null, email: 'anand@example.com' }],
    receivedAt: '2026-09-10T10:00:00Z',
    preview: '',
    hasAttachment: false,
});

const MAILBOXES: Record<string, { id: string }> = {
    inbox: { id: INBOX },
    sent: { id: SENT },
    archive: { id: ARCHIVE },
};

let changesResult: unknown;
let requestedMaxChanges: number | undefined;

const client = {
    getEmailState: vi.fn(async () => 'state-now'),
    resolveMailbox: vi.fn(async (name: string) => MAILBOXES[name.toLowerCase()] ?? null),
    getEmailChanges: vi.fn(async (_since: string, opts: { maxChanges?: number } = {}) => {
        requestedMaxChanges = opts.maxChanges;
        if (changesResult instanceof Error) throw changesResult;
        return changesResult;
    }),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

function run(params: Record<string, unknown> = {}) {
    const accountManager = new AccountManager({
        initialConfig: config,
        allowEnv: false,
        allowConfigFile: false,
    });
    return runWithRequestContext({ accountManager }, () =>
        changesSince(changesSinceSchema.parse(params))
    );
}

beforeEach(() => {
    changesResult = {
        newState: 'state-2',
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyedIds: [],
    };
    requestedMaxChanges = undefined;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('bootstrapping is explicit', () => {
    it('returns the current state and no changes when given none', async () => {
        // A delta tool that returned a whole mailbox instead would look like it
        // worked, which is the worst way for this to be wrong.
        const result = await run({});

        expect(result.bootstrapped).toBe(true);
        expect(result.newState).toBe('state-now');
        expect(result.created).toEqual([]);
        expect(client.getEmailChanges).not.toHaveBeenCalled();
    });

    it('validates the mailbox scope on the bootstrap path too', async () => {
        // The regression this pins. Bootstrap is the ONE call where the scope is
        // written for the first time, so it is exactly where a typo happens --
        // and it was the one path that skipped validation. The caller stored the
        // state, every later poll errored correctly, but nobody was looking by
        // then because the first call had "worked".
        await expect(run({ mailboxes: ['ZZZ-not-a-folder'] })).rejects.toThrow(/not found/);
    });

    it('does not hand back a state when the scope was never valid', async () => {
        await expect(run({ mailboxes: ['Inbox', 'Inobx'] })).rejects.toThrow(/Inobx/);
        expect(client.getEmailState).not.toHaveBeenCalled();
    });

    it('still bootstraps normally with a valid scope', async () => {
        const result = await run({ mailboxes: ['Inbox', 'Sent'] });

        expect(result.bootstrapped).toBe(true);
        expect(result.newState).toBe('state-now');
    });

    it('does not bootstrap once a state is supplied', async () => {
        const result = await run({ state: 'state-1' });

        expect(result.bootstrapped).toBe(false);
        expect(client.getEmailChanges).toHaveBeenCalled();
    });
});

describe('a stale state throws rather than reporting nothing', () => {
    it('propagates cannotCalculateChanges', async () => {
        // The one error a caller must never mistake for "nothing changed": an
        // empty list here would freeze their cache while looking healthy.
        changesResult = new Error('cannotCalculateChanges: ... perform a full resync ...');

        await expect(run({ state: 'ancient' })).rejects.toThrow(/cannotCalculateChanges/);
    });
});

describe('mailbox scope', () => {
    beforeEach(() => {
        changesResult = {
            newState: 'state-2',
            hasMoreChanges: false,
            created: [email('E1', [INBOX]), email('E2', [ARCHIVE])],
            updated: [email('E3', [SENT]), email('E4', [ARCHIVE])],
            destroyedIds: ['E9'],
        };
    });

    it('returns everything when no scope is given', async () => {
        const result = await run({ state: 's' });

        expect(result.created).toHaveLength(2);
        expect(result.updated).toHaveLength(2);
        expect(result.departedIds).toEqual([]);
    });

    it('filters to the requested mailboxes', async () => {
        const result = await run({ state: 's', mailboxes: ['Inbox', 'Sent'] });

        expect(result.created.map((e) => e.id)).toEqual(['E1']);
        expect(result.updated.map((e) => e.id)).toEqual(['E3']);
    });

    it('reports what left the scope instead of dropping it silently', async () => {
        // Without this a scoped feed is worse than an unscoped one: a message
        // filed elsewhere would simply stop appearing and the caller would hold
        // it as current forever.
        const result = await run({ state: 's', mailboxes: ['Inbox', 'Sent'] });

        expect(result.departedIds.sort()).toEqual(['E2', 'E4']);
    });

    it('keeps destroyed ids regardless of scope, since they are gone entirely', async () => {
        const result = await run({ state: 's', mailboxes: ['Inbox'] });

        expect(result.destroyedIds).toEqual(['E9']);
    });

    it('errors on an unresolvable mailbox rather than matching nothing', async () => {
        // An empty scope would report "no changes" for a misspelled mailbox,
        // which is indistinguishable from a quiet one.
        await expect(run({ state: 's', mailboxes: ['Inbxo'] })).rejects.toThrow(/not found/);
    });

    it('resolves scope by role, so Junk finds a folder named Spam', async () => {
        await run({ state: 's', mailboxes: ['Inbox'] });

        expect(client.resolveMailbox).toHaveBeenCalledWith('Inbox');
    });

    it('counts a message in several mailboxes as in scope', async () => {
        changesResult = {
            newState: 'state-2',
            hasMoreChanges: false,
            created: [email('E5', [ARCHIVE, INBOX])],
            updated: [],
            destroyedIds: [],
        };

        const result = await run({ state: 's', mailboxes: ['Inbox'] });

        expect(result.created.map((e) => e.id)).toEqual(['E5']);
        expect(result.departedIds).toEqual([]);
    });
});

describe('paging and shape', () => {
    it('passes maxChanges through and defaults to 128', async () => {
        await run({ state: 's' });
        expect(requestedMaxChanges).toBe(128);

        await run({ state: 's', maxChanges: 32 });
        expect(requestedMaxChanges).toBe(32);
    });

    it('surfaces hasMoreChanges so the caller knows to continue', async () => {
        changesResult = {
            newState: 'state-2',
            hasMoreChanges: true,
            created: [],
            updated: [],
            destroyedIds: [],
        };

        expect((await run({ state: 's' })).hasMoreChanges).toBe(true);
    });

    it('returns the same summary shape a search does', async () => {
        changesResult = {
            newState: 'state-2',
            hasMoreChanges: false,
            created: [email('E1', [INBOX], { $seen: true })],
            updated: [],
            destroyedIds: [],
        };

        const [row] = (await run({ state: 's' })).created;

        expect(row).toMatchObject({
            id: 'E1',
            threadId: 'T-E1',
            messageId: ['E1@example.com'],
            isRead: true,
            isFlagged: false,
        });
    });

    it('accepts maxChanges as a string, as clients send it', async () => {
        await run({ state: 's', maxChanges: '64' });

        expect(requestedMaxChanges).toBe(64);
    });
});
