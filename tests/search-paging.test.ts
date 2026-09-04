/**
 * Paging and truncation reporting for search_emails.
 *
 * The tool has always capped results at 100. The cap is correct -- these
 * results go into a model's context window, so an unbounded page is the harm it
 * exists to prevent. What was wrong is that a truncated set was indistinguishable
 * from a complete one: `total` reported the page size wearing the name of the
 * match count, and there was no offset with which to fetch the rest.
 *
 * Found when a downstream consumer's coverage turned out to be 15 of 49
 * messages, with nothing in the response indicating the other 34 existed.
 */

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

/** A corpus large enough that a default page cannot hold it. */
const TOTAL_MATCHES = 249;

const email = (id: string) => ({
    id,
    threadId: `T-${id}`,
    messageId: [`${id}@example.com`],
    inReplyTo: null,
    references: null,
    subject: `Message ${id}`,
    from: [{ name: null, email: 'sender@example.com' }],
    to: [{ name: null, email: 'anand@example.com' }],
    receivedAt: '2026-09-01T10:00:00Z',
    preview: '',
    hasAttachment: false,
    keywords: {},
});

/** Captures what the tool asked JMAP for, so we assert on the request too. */
let requested: { limit?: number; position?: number } | undefined;

const client = {
    getMailboxByRole: vi.fn(async () => null),
    resolveMailbox: vi.fn(async () => ({ id: 'mbx-inbox', role: 'inbox' })),
    queryEmailsPage: vi.fn(
        async (
            _filter: unknown,
            _sort: unknown,
            options: { limit?: number; position?: number } = {}
        ) => {
            requested = options;
            const limit = options.limit ?? 20;
            const position = options.position ?? 0;
            const count = Math.max(0, Math.min(limit, TOTAL_MATCHES - position));
            return {
                ids: Array.from({ length: count }, (_, i) => `E${position + i}`),
                total: TOTAL_MATCHES,
                position,
            };
        }
    ),
    getEmails: vi.fn(async (ids: string[]) => ids.map(email)),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

/**
 * Parses through the schema before calling the handler, exactly as the tool
 * dispatcher does. Calling the handler directly would skip validation and
 * coercion entirely -- which it did in an earlier draft of these tests, making
 * them pass for reasons that had nothing to do with the code under test.
 */
function search(params: Record<string, unknown> = {}) {
    const accountManager = new AccountManager({
        initialConfig: config,
        allowEnv: false,
        allowConfigFile: false,
    });
    return runWithRequestContext({ accountManager }, () =>
        searchEmails(searchEmailsSchema.parse(params))
    );
}

describe('truncation is visible', () => {
    beforeEach(() => {
        requested = undefined;
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('reports the number of matches, not the size of the page', async () => {
        // The original defect: 249 matches were reported as "total: 20".
        const result = await search();

        expect(result.total).toBe(TOTAL_MATCHES);
        expect(result.returned).toBe(20);
    });

    it('says there is more when the set was truncated', async () => {
        expect((await search()).hasMore).toBe(true);
    });

    it('says there is no more when the page holds everything', async () => {
        const result = await search({ limit: 100, position: 200 });

        expect(result.returned).toBe(49);
        expect(result.hasMore).toBe(false);
    });

    it('echoes the offset back, so a caller can compute the next one', async () => {
        expect((await search({ position: 40 })).position).toBe(40);
    });
});

describe('paging', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('passes the offset through to JMAP rather than slicing locally', async () => {
        await search({ position: 60, limit: 30 });

        expect(requested).toEqual({ limit: 30, position: 60 });
    });

    it('returns a different page for a different offset', async () => {
        const first = await search({ limit: 20, position: 0 });
        const second = await search({ limit: 20, position: 20 });

        expect(first.emails[0].id).toBe('E0');
        expect(second.emails[0].id).toBe('E20');
    });

    it('walks the whole set without overlap or omission', async () => {
        // The consumer-facing guarantee: page until hasMore is false and you
        // have every match exactly once.
        const seen: string[] = [];
        let position = 0;
        for (;;) {
            const page = await search({ limit: 100, position });
            seen.push(...page.emails.map((e) => e.id));
            if (!page.hasMore) break;
            position += page.returned;
        }

        expect(seen).toHaveLength(TOTAL_MATCHES);
        expect(new Set(seen).size).toBe(TOTAL_MATCHES);
    });

    it('returns an empty page past the end rather than failing', async () => {
        const result = await search({ position: TOTAL_MATCHES + 10 });

        expect(result.emails).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.total).toBe(TOTAL_MATCHES);
    });
});

describe('limit and position are sanitised', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('caps an over-large limit at 100 instead of honouring it', async () => {
        await search({ limit: 5000 });

        expect(requested?.limit).toBe(100);
    });

    it('still reports the true total when the request was capped', async () => {
        // Capping must not become a second way to hide the size of the set.
        const result = await search({ limit: 5000 });

        expect(result.returned).toBe(100);
        expect(result.total).toBe(TOTAL_MATCHES);
        expect(result.hasMore).toBe(true);
    });

    it('treats a negative offset as the start, not as an offset from the end', async () => {
        // JMAP reads a negative position as relative to the end of the result
        // set, which would quietly return a different page than intended.
        await search({ position: -5 });

        expect(requested?.position).toBe(0);
    });

    it('truncates a fractional offset rather than passing it through', async () => {
        await search({ position: 12.7 });

        expect(requested?.position).toBe(12);
    });

    it('defaults to the first page when no offset is given', async () => {
        await search({});

        expect(requested?.position).toBe(0);
    });
});

describe('numeric inputs survive a client that sends strings', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('accepts a string offset, as clients actually send', async () => {
        // Observed live: a client sent position as "0" and the call failed
        // validation, which the user could do nothing about.
        const result = await search({ position: '40' });

        expect(requested?.position).toBe(40);
        expect(result.position).toBe(40);
    });

    it('accepts a string limit', async () => {
        await search({ limit: '30' });

        expect(requested?.limit).toBe(30);
    });

    it('still rejects a value that is not a number at all', () => {
        expect(() => searchEmailsSchema.parse({ limit: 'twenty' })).toThrow();
    });

    it('rejects Infinity, which coercion alone would let through', () => {
        // Number("Infinity") is a valid number, so only .finite() stops it
        // reaching the query as a position.
        expect(() => searchEmailsSchema.parse({ position: 'Infinity' })).toThrow();
    });
});
