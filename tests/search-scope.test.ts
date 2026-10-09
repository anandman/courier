import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { searchEmails, searchEmailsSchema } from '../src/tools/search.js';

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

/**
 * The leaf conditions of a filter, whatever shape it arrived in.
 *
 * Filters became expression trees when the search parameters learned to take
 * lists -- "from any of these" has no flat representation in JMAP. These tests
 * are about what is being asked for, not how it is nested, so they read through
 * the operators rather than asserting a structure that is free to change.
 */
function leaves(filter: unknown): Record<string, unknown>[] {
    if (!filter || typeof filter !== 'object') return [];
    const node = filter as { operator?: string; conditions?: unknown[] };
    if (node.operator && Array.isArray(node.conditions)) {
        return node.conditions.flatMap(leaves);
    }
    return [filter as Record<string, unknown>];
}

/** The value of one filter field, wherever in the tree it was set. */
function conditionFor(field: string): unknown {
    return leaves(capturedFilter).find((leaf) => leaf[field] !== undefined)?.[field];
}

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
        expect(conditionFor('inMailboxOtherThan')).toEqual(['mbx-junk', 'mbx-trash']);
        expect(conditionFor('inMailbox')).toBeUndefined();
    });

    it('still searches Archive, Sent and custom folders by default', async () => {
        await search({ limit: 20 });

        // Exclusion must be a denylist, not a narrowing to Inbox -- otherwise
        // "find that email from Bob" would stop finding archived mail.
        expect(conditionFor('inMailbox')).toBeUndefined();
        expect(conditionFor('inMailboxOtherThan')).not.toContain('mbx-inbox');
    });

    it('searches only the named mailbox when one is given', async () => {
        await search({ mailbox: 'Inbox', limit: 20 });

        expect(conditionFor('inMailbox')).toBe('mbx-inbox');
        expect(conditionFor('inMailboxOtherThan')).toBeUndefined();
    });

    it('searches Junk when Junk is asked for explicitly', async () => {
        await search({ mailbox: 'Junk', limit: 20 });

        // Naming the mailbox is the opt-in; the default exclusion must not
        // survive and produce a query that can never match anything.
        expect(conditionFor('inMailbox')).toBe('mbx-junk');
        expect(conditionFor('inMailboxOtherThan')).toBeUndefined();
    });

    it('omits the exclusion when the account has no Junk or Trash mailbox', async () => {
        client.getMailboxByRole.mockResolvedValue(null);

        await search({ limit: 20 });

        // An empty inMailboxOtherThan array is a filter JMAP would reject.
        expect(conditionFor('inMailboxOtherThan')).toBeUndefined();
    });
});

describe('what the filters say they do', () => {
    /**
     * The provider tokenises these filters on punctuation, so they match whole
     * words rather than substrings. Described as "Filter by sender email or
     * name", a consumer reasonably read it as a substring match, searched for
     * a company by a prefix of its domain, got zero results and reported to its
     * user that no mail had arrived. Four messages had.
     *
     * The behaviour is the provider's and is defensible. The description was
     * ours and was not.
     */
    it('warns that sender matching is by whole word', () => {
        const description = searchEmailsSchema.shape.from.description ?? '';

        expect(description).toMatch(/WHOLE WORDS/);
        expect(description).toMatch(/NOT guidepointglobal/);
    });

    it('says the same for recipient and subject', () => {
        expect(searchEmailsSchema.shape.to.description ?? '').toMatch(/whole words/);
        expect(searchEmailsSchema.shape.subject.description ?? '').toMatch(/whole words/);
    });
});

describe('matching any of several values', () => {
    beforeEach(() => {
        capturedFilter = undefined;
        client.getMailboxByRole.mockImplementation(async (role: string) => MAILBOXES[role] ?? null);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    /** Every leaf condition naming a field, in tree order. */
    const valuesFor = (field: string) =>
        leaves(capturedFilter)
            .filter((leaf) => leaf[field] !== undefined)
            .map((leaf) => leaf[field]);

    /**
     * The saving this exists for. A consumer issued ELEVEN separate paged
     * searches per full fetch, one per sender domain, because "from any of
     * these" could not be expressed -- and measured that as the whole of its
     * 26.8s. JMAP has supported the combination since RFC 8620; nothing here
     * exposed it.
     */
    it('turns a list of senders into one query', async () => {
        await search({ from: ['a.example', 'b.example', 'c.example'], limit: 20 });

        expect(valuesFor('from')).toEqual(['a.example', 'b.example', 'c.example']);
        expect(JSON.stringify(capturedFilter)).toContain('"OR"');
    });

    /**
     * A single value must produce exactly what it produced before this existed,
     * so a query that was already correct cannot change shape -- and the
     * provider's planner is handed nothing to see through.
     */
    it('does not wrap a single value in an operator', async () => {
        await search({ from: 'solo.example', limit: 20 });

        const text = JSON.stringify(capturedFilter);
        expect(text).toContain('solo.example');
        expect(text).not.toContain('"OR"');
    });

    it('accepts a list for recipients and CC too', async () => {
        await search({ to: ['x@example.com', 'y@example.com'], cc: ['z@example.com'], limit: 20 });

        expect(valuesFor('to')).toEqual(['x@example.com', 'y@example.com']);
        expect(valuesFor('cc')).toEqual(['z@example.com']);
    });

    /**
     * "Did I correspond with X" should not require knowing which field they
     * appeared in. JMAP has no such filter, so it is an OR across the four that
     * exist -- previously three or four separate searches.
     */
    it('matches a participant in any address field', async () => {
        await search({ participant: 'dan@example.com', limit: 20 });

        expect(valuesFor('from')).toEqual(['dan@example.com']);
        expect(valuesFor('to')).toEqual(['dan@example.com']);
        expect(valuesFor('cc')).toEqual(['dan@example.com']);
        expect(valuesFor('bcc')).toEqual(['dan@example.com']);
    });

    it('searches several mailboxes at once', async () => {
        await search({ mailbox: ['Inbox', 'Junk'], limit: 20 });

        expect(valuesFor('inMailbox')).toEqual(['mbx-inbox', 'mbx-junk']);
        expect(conditionFor('inMailboxOtherThan')).toBeUndefined();
    });

    /**
     * Named and refused rather than quietly dropped. A search that silently
     * skipped one of three mailboxes would return a smaller answer that looks
     * complete -- the failure this project keeps producing.
     */
    it('refuses the whole search when one mailbox does not exist', async () => {
        await expect(search({ mailbox: ['Inbox', 'Nonsense'], limit: 20 })).rejects.toThrow(
            /Mailbox not found: Nonsense/
        );
    });

    it('filters on keywords, and on their absence', async () => {
        await search({ hasKeyword: ['invoice', 'paid'], lacksKeyword: 'archived', limit: 20 });

        expect(valuesFor('hasKeyword')).toEqual(['invoice', 'paid', 'archived']);
        // The absent one sits under a NOT; the present ones do not.
        expect(JSON.stringify(capturedFilter)).toContain('"NOT"');
    });

    it('still ANDs unrelated parameters together', async () => {
        await search({ from: ['a.example', 'b.example'], subject: 'invoice', isUnread: true, limit: 20 });

        expect(valuesFor('subject')).toEqual(['invoice']);
        expect(valuesFor('notKeyword')).toEqual(['$seen']);
        expect(JSON.stringify(capturedFilter)).toContain('"AND"');
    });
});

describe('searching inside one conversation', () => {
    const THREAD = [
        { id: 'a', threadId: 'T', subject: 'Budget', from: [{ email: 'dan@example.com', name: 'Dan' }], to: [{ email: 'me@example.com', name: null }], cc: null, bcc: null, receivedAt: '2026-01-01T00:00:00Z', preview: 'first', keywords: { $seen: true }, hasAttachment: false, messageId: ['<a>'], inReplyTo: null, references: null, textBody: [{ partId: 'p' }], bodyValues: { p: { value: 'the Q3 numbers are attached' } } },
        { id: 'b', threadId: 'T', subject: 'Re: Budget', from: [{ email: 'me@example.com', name: null }], to: [{ email: 'dan@example.com', name: 'Dan' }], cc: null, bcc: null, receivedAt: '2026-02-01T00:00:00Z', preview: 'second', keywords: {}, hasAttachment: true, messageId: ['<b>'], inReplyTo: ['<a>'], references: ['<a>'], textBody: [{ partId: 'p' }], bodyValues: { p: { value: 'thanks, looks fine' } } },
    ];

    beforeEach(() => {
        capturedFilter = undefined;
        client.getThread = vi.fn(async () => THREAD);
    });

    afterEach(() => vi.clearAllMocks());

    /**
     * JMAP has no filter for a conversation, so this is answered by reading the
     * thread rather than querying. A thread is bounded and usually small, so it
     * is one extra round trip -- and it yields an accurate total, which
     * intersecting a paged query against the thread's ids would not.
     */
    it('reads the thread instead of querying', async () => {
        const result = await search({ threadId: 'T', limit: 20 });

        expect(client.getThread).toHaveBeenCalledWith('T', expect.anything());
        expect(client.queryEmailsPage).not.toHaveBeenCalled();
        expect(result.total).toBe(2);
        expect(result.returned).toBe(2);
    });

    it('applies the other filters within it', async () => {
        const result = await search({ threadId: 'T', from: 'dan@example.com', limit: 20 });

        expect(result.emails.map((e) => e.id)).toEqual(['a']);
        expect(result.total).toBe(1);
    });

    it('filters on flags and attachments the same way', async () => {
        expect((await search({ threadId: 'T', isUnread: true, limit: 20 })).emails.map((e) => e.id)).toEqual(['b']);
        expect((await search({ threadId: 'T', hasAttachment: true, limit: 20 })).emails.map((e) => e.id)).toEqual(['b']);
    });

    it('matches a participant in any field', async () => {
        expect((await search({ threadId: 'T', participant: 'dan@example.com', limit: 20 })).total).toBe(2);
    });

    /**
     * The one filter that behaves differently, and the parameter says so. The
     * provider tokenises and matches whole words; reproducing that faithfully
     * here is not possible, so this is a substring match -- MORE permissive,
     * never less, so a caller cannot miss a message it would otherwise find.
     */
    it('searches text as a substring, which the parameter admits', async () => {
        const result = await search({ threadId: 'T', query: 'Q3 numbers', limit: 20 });
        expect(result.emails.map((e) => e.id)).toEqual(['a']);

        const description = searchEmailsSchema.shape.threadId.description ?? '';
        expect(description).toMatch(/SUBSTRING/);
        expect(description).toMatch(/whole-word/);
    });

    it('pages within the conversation and reports the true total', async () => {
        const result = await search({ threadId: 'T', limit: 1, position: 1 });

        expect(result.returned).toBe(1);
        expect(result.total).toBe(2);
        expect(result.position).toBe(1);
        expect(result.hasMore).toBe(false);
    });
});
