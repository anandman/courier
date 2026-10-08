import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { deleteEmails, markEmails, moveEmails, tagEmails } from '../src/tools/organize.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'me@example.com',
};

const MAILBOXES = [
    { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
    { id: 'mb-archive', name: 'Archive', role: 'archive' },
    { id: 'mb-trash', name: 'Trash', role: 'trash' },
];

let notUpdated: Record<string, { type: string; description?: string }>;
let lastUpdates: Record<string, Record<string, unknown>> | undefined;

const client = {
    getMailboxes: vi.fn(async () => MAILBOXES),
    getMailboxByRole: vi.fn(async (role: string) => MAILBOXES.find((m) => m.role === role) ?? null),
    resolveMailbox: vi.fn(async (name: string) => MAILBOXES.find((m) => m.name === name) ?? null),
    getEmails: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
            id,
            mailboxIds: { 'mb-inbox': true },
            keywords: { $seen: true, invoice: true },
        }))
    ),
    updateEmailsDetailed: vi.fn(async (updates: Record<string, Record<string, unknown>>) => {
        lastUpdates = updates;
        return { updated: Object.keys(updates).filter((id) => !(id in notUpdated)), notUpdated };
    }),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

beforeEach(() => {
    notUpdated = {};
    lastUpdates = undefined;
    vi.clearAllMocks();
});

const run = <T>(fn: () => Promise<T>) => {
    const accountManager = new AccountManager({ initialConfig: config, allowEnv: false, allowConfigFile: false });
    return runWithRequestContext({ accountManager }, fn);
};

describe('reporting per message rather than per batch', () => {
    /**
     * JMAP applies an Email/set per id, so a batch genuinely can half succeed.
     * The old shape was a count and a cheerful sentence, which could say
     * "Moved 100 email(s)" when three had not moved -- or raise a single error
     * after ninety-seven had. Neither told a caller which was which.
     */
    it('names which messages failed and why', async () => {
        notUpdated = { b: { type: 'notFound', description: 'No such email' } };

        const result = await run(() => moveEmails({ emailIds: ['a', 'b', 'c'], mailbox: 'Archive' }));

        expect(result.success).toBe(false);
        expect(result.requested).toBe(3);
        expect(result.count).toBe(2);
        expect(result.failed).toBe(1);
        expect(result.results.find((r) => r.emailId === 'b')).toMatchObject({
            ok: false,
            reason: 'No such email',
        });
    });

    /**
     * A caller checking one boolean is the common case, and it should be wrong
     * in the safe direction.
     */
    it('does not report success for a partial batch', async () => {
        notUpdated = { c: { type: 'forbidden' } };
        const result = await run(() => moveEmails({ emailIds: ['a', 'c'], mailbox: 'Archive' }));

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/1 of 2/);
        expect(result.message).toMatch(/did not move/);
    });

    it('reports success when everything applied', async () => {
        const result = await run(() => moveEmails({ emailIds: ['a', 'b'], mailbox: 'Archive' }));

        expect(result.success).toBe(true);
        expect(result.count).toBe(2);
        expect(result.failed).toBe(0);
    });
});

describe('carrying back what the message was before', () => {
    /**
     * This is the stateless alternative to an undo token. Keeping prior state
     * on the server would mean a store and a lifetime to manage; handing the
     * same information to the caller costs nothing to keep and cannot go stale.
     */
    it('says which mailboxes a moved message came from', async () => {
        const result = await run(() => moveEmails({ emailIds: ['a'], mailbox: 'Archive' }));

        expect(result.results[0].previousMailboxes).toEqual(['Inbox']);
        expect(result.message).toMatch(/can be reversed/);
    });

    it('uses mailbox names, not ids, so the reversal is callable', async () => {
        // move_emails takes a name. Returning an id would make the caller
        // resolve it back, which it has no tool to do.
        const result = await run(() => deleteEmails({ emailIds: ['a'] }));

        expect(result.results[0].previousMailboxes).toEqual(['Inbox']);
    });

    it('says which keywords a marked message had', async () => {
        const result = await run(() => markEmails({ emailIds: ['a'], isRead: false }));

        expect(result.results[0].previousKeywords).toEqual(['$seen', 'invoice']);
    });

    it('says the same for tagging', async () => {
        const result = await run(() => tagEmails({ emailIds: ['a'], addKeywords: ['urgent'] }));

        expect(result.results[0].previousKeywords).toContain('invoice');
        expect(result.message).toMatch(/reversed exactly/);
    });

    it('does not claim prior state for a message that failed', async () => {
        notUpdated = { a: { type: 'notFound' } };
        const result = await run(() => moveEmails({ emailIds: ['a'], mailbox: 'Archive' }));

        expect(result.results[0].previousMailboxes).toBeUndefined();
    });
});

describe('what the tools actually ask JMAP to do', () => {
    it('moves by replacing the mailbox set', async () => {
        await run(() => moveEmails({ emailIds: ['a'], mailbox: 'Archive' }));
        expect(lastUpdates?.a).toEqual({ mailboxIds: { 'mb-archive': true } });
    });

    it('deletes by moving to Trash, which is recoverable', async () => {
        await run(() => deleteEmails({ emailIds: ['a'] }));

        expect(lastUpdates?.a).toEqual({ mailboxIds: { 'mb-trash': true } });
        const result = await run(() => deleteEmails({ emailIds: ['a'] }));
        expect(result.message).toMatch(/recovered/);
    });

    it('patches individual keywords rather than replacing the set', async () => {
        // Replacing would silently drop every other keyword on the message.
        await run(() => tagEmails({ emailIds: ['a'], addKeywords: ['urgent'], removeKeywords: ['invoice'] }));

        expect(lastUpdates?.a).toEqual({ 'keywords/urgent': true, 'keywords/invoice': null });
    });

    it('unsets a flag with null rather than false', async () => {
        await run(() => markEmails({ emailIds: ['a'], isRead: false, isFlagged: true }));

        expect(lastUpdates?.a).toEqual({ 'keywords/$seen': null, 'keywords/$flagged': true });
    });
});

describe('refusing calls that would do nothing', () => {
    it('refuses a mark with nothing to change', async () => {
        await expect(run(() => markEmails({ emailIds: ['a'] }))).rejects.toThrow(/Nothing to change/);
    });

    it('refuses a tag with nothing to change', async () => {
        await expect(run(() => tagEmails({ emailIds: ['a'] }))).rejects.toThrow(/Nothing to change/);
    });

    it('accepts an empty list as a no-op', async () => {
        const result = await run(() => moveEmails({ emailIds: [], mailbox: 'Archive' }));

        expect(result.success).toBe(true);
        expect(result.requested).toBe(0);
        expect(client.updateEmailsDetailed).not.toHaveBeenCalled();
    });
});
