import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { searchEmails } from '../src/tools/search.js';

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

const MAILBOXES: Record<string, { id: string; role: string | null }> = {
    inbox: { id: 'mbx-inbox', role: 'inbox' },
    junk: { id: 'mbx-junk', role: 'junk' },
    trash: { id: 'mbx-trash', role: 'trash' },
};

/** Captures the filter handed to JMAP so we can assert on the query, not the results. */
let capturedFilter: Record<string, unknown> | undefined;

const client = {
    getMailboxByRole: vi.fn(async (role: string) => MAILBOXES[role] ?? null),
    resolveMailbox: vi.fn(async (idOrName: string) => MAILBOXES[idOrName.toLowerCase()] ?? null),
    queryEmailsPage: vi.fn(async (filter: Record<string, unknown> | undefined) => {
        capturedFilter = filter;
        return { ids: [], total: 0, position: 0 };
    }),
    getEmails: vi.fn(async () => []),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

/** Runs a search against a fixed single-account manager, returning the JMAP filter it built. */
function search(params: Parameters<typeof searchEmails>[0]) {
    const accountManager = new AccountManager({
        initialConfig: config,
        allowEnv: false,
        allowConfigFile: false,
    });
    return runWithRequestContext({ accountManager }, () => searchEmails(params));
}

describe('search_emails default scope', () => {
    beforeEach(() => {
        capturedFilter = undefined;
        client.getMailboxByRole.mockImplementation(async (role: string) => MAILBOXES[role] ?? null);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('excludes Junk and Trash when no mailbox is given', async () => {
        await search({ isUnread: true, limit: 20 });

        // The whole point: an unscoped JMAP query otherwise spans every mailbox,
        // so "my latest unread message" could return spam.
        expect(capturedFilter?.inMailboxOtherThan).toEqual(['mbx-junk', 'mbx-trash']);
        expect(capturedFilter?.inMailbox).toBeUndefined();
    });

    it('still searches Archive, Sent and custom folders by default', async () => {
        await search({ limit: 20 });

        // Exclusion must be a denylist, not a narrowing to Inbox -- otherwise
        // "find that email from Bob" would stop finding archived mail.
        expect(capturedFilter?.inMailbox).toBeUndefined();
        expect(capturedFilter?.inMailboxOtherThan).not.toContain('mbx-inbox');
    });

    it('searches only the named mailbox when one is given', async () => {
        await search({ mailbox: 'Inbox', limit: 20 });

        expect(capturedFilter?.inMailbox).toBe('mbx-inbox');
        expect(capturedFilter?.inMailboxOtherThan).toBeUndefined();
    });

    it('searches Junk when Junk is asked for explicitly', async () => {
        await search({ mailbox: 'Junk', limit: 20 });

        // Naming the mailbox is the opt-in; the default exclusion must not
        // survive and produce a query that can never match anything.
        expect(capturedFilter?.inMailbox).toBe('mbx-junk');
        expect(capturedFilter?.inMailboxOtherThan).toBeUndefined();
    });

    it('omits the exclusion when the account has no Junk or Trash mailbox', async () => {
        client.getMailboxByRole.mockResolvedValue(null);

        await search({ limit: 20 });

        // An empty inMailboxOtherThan array is a filter JMAP would reject.
        expect(capturedFilter?.inMailboxOtherThan).toBeUndefined();
    });
});
