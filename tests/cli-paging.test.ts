import { describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../src/cli/exit.js';
import {
    DEFAULT_ALL_PAGE_SIZE,
    DEFAULT_MAX_PAGES,
    asPage,
    collectAllPages,
    pageSizeForAll,
} from '../src/cli/paging.js';

function page(position: number, returned: number, total: number) {
    return {
        emails: Array.from({ length: returned }, (_, index) => ({ id: `e${position + index}` })),
        total,
        position,
        returned,
        hasMore: position + returned < total,
        account: 'personal@example.com',
    };
}

describe('recognising a paged result', () => {
    it('reads a search result as a page', () => {
        const recognised = asPage(page(0, 2, 5));

        expect(recognised?.total).toBe(5);
        expect(recognised?.itemsKey).toBe('emails');
        expect(recognised?.items).toHaveLength(2);
    });

    /**
     * A result missing a paging field is not treated as one complete page.
     * Assuming completeness from an absent field is precisely how a partial
     * answer comes to look total.
     */
    it('declines anything without the full set of paging fields', () => {
        expect(asPage({ emails: [], total: 0, position: 0, returned: 0 })).toBeUndefined();
        expect(asPage({ emails: [], total: 0, position: 0, hasMore: false })).toBeUndefined();
        expect(asPage({ accounts: [], currentAccount: null })).toBeUndefined();
        expect(asPage('text')).toBeUndefined();
        expect(asPage(null)).toBeUndefined();
        expect(asPage([1, 2, 3])).toBeUndefined();
    });

    it('finds the item array by its length rather than by a hardcoded name', () => {
        const recognised = asPage({ contacts: [1, 2], total: 2, position: 0, returned: 2, hasMore: false });
        expect(recognised?.itemsKey).toBe('contacts');
    });
});

describe('walking every page', () => {
    it('concatenates the pages and reports the set as complete', async () => {
        const pages = [page(0, 2, 5), page(2, 2, 5), page(4, 1, 5)];
        const result = await collectAllPages(
            asPage(pages[0])!,
            async (position) => pages.find((candidate) => candidate.position === position),
            'search_emails'
        );

        expect((result.emails as unknown[]).map((email) => (email as { id: string }).id)).toEqual([
            'e0',
            'e1',
            'e2',
            'e3',
            'e4',
        ]);
        expect(result.returned).toBe(5);
        expect(result.total).toBe(5);
        expect(result.hasMore).toBe(false);
        expect(result.pages).toBe(3);
    });

    it('needs no second request when the first page is the whole set', async () => {
        let calls = 0;
        const result = await collectAllPages(
            asPage(page(0, 3, 3))!,
            async () => {
                calls += 1;
                return undefined;
            },
            'search_emails'
        );

        expect(calls).toBe(0);
        expect(result.returned).toBe(3);
    });

    /**
     * The central property. Three pages fetched, the fourth fails -- and the
     * caller gets nothing rather than three pages' worth of data that looks
     * like a complete answer.
     */
    it('discards everything when a later page fails', async () => {
        const pages = [page(0, 2, 6), page(2, 2, 6)];

        await expect(
            collectAllPages(
                asPage(pages[0])!,
                async (position) => {
                    const found = pages.find((candidate) => candidate.position === position);
                    if (!found) throw new CliError(EXIT.UNREACHABLE, 'connection reset');
                    return found;
                },
                'search_emails'
            )
        ).rejects.toThrow(/connection reset/);
    });

    it('keeps a transport failure labelled as a transport failure', async () => {
        // Relabelling it `incomplete` would tell a caller to narrow its query
        // when the real answer is to retry.
        try {
            await collectAllPages(
                asPage(page(0, 2, 6))!,
                async () => {
                    throw new CliError(EXIT.UNREACHABLE, 'connection reset');
                },
                'search_emails'
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.UNREACHABLE);
        }
    });

    it('reports incomplete when a page stops carrying paging fields', async () => {
        try {
            await collectAllPages(
                asPage(page(0, 2, 6))!,
                async () => ({ emails: [{ id: 'x' }] }),
                'search_emails'
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.INCOMPLETE);
            expect((error as CliError).message).toMatch(/discarded/);
        }
    });

    it('stops at the page ceiling rather than running unbounded', async () => {
        try {
            await collectAllPages(
                asPage(page(0, 2, 1000))!,
                async (position) => page(position, 2, 1000),
                'search_emails',
                { maxPages: 3 }
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.INCOMPLETE);
            expect((error as CliError).message).toMatch(/stopped after 3 pages/);
        }
    });

    it('refuses to loop on a page that claims more but returns none', async () => {
        try {
            await collectAllPages(
                asPage(page(0, 2, 6))!,
                async (position) => ({ emails: [], total: 6, position, returned: 0, hasMore: true }),
                'search_emails'
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.INCOMPLETE);
        }
    });

    /**
     * The pages stop before the declared total is reached. The array would look
     * fine -- four plausible results -- and the count is the only evidence that
     * two were never seen, so the count is what gets checked.
     */
    it('refuses a set whose pages do not add up to its total', async () => {
        const pages = [page(0, 2, 6), { ...page(2, 2, 6), hasMore: false }];

        try {
            await collectAllPages(
                asPage(pages[0])!,
                async (position) => pages.find((candidate) => candidate.position === position),
                'search_emails'
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.INCOMPLETE);
            expect((error as CliError).message).toMatch(/changed while it was being read/);
        }
    });

    /**
     * A mailbox that changed mid-walk is not by itself an error: new mail
     * arrives constantly, and refusing every search that raced an arrival would
     * make --all useless. What must not pass is a count that does not add up,
     * which the test above covers. A coherent set measured against the latest
     * total is accepted.
     */
    it('accepts a set that shrank but still adds up', async () => {
        const pages = [page(0, 2, 5), { emails: [{ id: 'e2' }, { id: 'e3' }], total: 4, position: 2, returned: 2, hasMore: false }];

        const result = await collectAllPages(
            asPage(pages[0])!,
            async (position) => pages.find((candidate) => candidate.position === position),
            'search_emails'
        );

        expect(result.returned).toBe(4);
        expect(result.total).toBe(4);
    });

    it('reports progress as it goes', async () => {
        const pages = [page(0, 2, 4), page(2, 2, 4)];
        const progress: string[] = [];

        await collectAllPages(
            asPage(pages[0])!,
            async (position) => pages.find((candidate) => candidate.position === position),
            'search_emails',
            { onPage: (fetched, total) => progress.push(`${fetched}/${total}`) }
        );

        expect(progress).toEqual(['2/4', '4/4']);
    });
});

describe('the page size --all asks for', () => {
    /**
     * A consumer measured 434 messages at 22 round trips and 8.0s with the
     * per-call default of 20, against 5 round trips and 2.1s at 100. The
     * ceiling was the worse half: 20 x 50 pages capped `--all` at 1000 results,
     * high enough to look correct on anything small and silently short on a
     * real mailbox.
     */
    it('prefers a maximum the schema advertises', () => {
        expect(pageSizeForAll({ maximum: 250 })).toBe(250);
    });

    it('falls back to a page size the server will cap anyway', () => {
        expect(pageSizeForAll(undefined)).toBe(DEFAULT_ALL_PAGE_SIZE);
        expect(pageSizeForAll({})).toBe(DEFAULT_ALL_PAGE_SIZE);
    });

    it('ignores a maximum that is not a usable number', () => {
        // Guessing high is safe -- Courier caps the value rather than rejecting
        // it, and the walk follows `returned`, not what it asked for.
        for (const maximum of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100', null]) {
            expect(pageSizeForAll({ maximum }), String(maximum)).toBe(DEFAULT_ALL_PAGE_SIZE);
        }
    });

    it('asks for more than one page would hold, so the ceiling is not the binding limit', () => {
        // 50 pages at this size is 5000 results; at the old default it was 1000.
        expect(DEFAULT_ALL_PAGE_SIZE * DEFAULT_MAX_PAGES).toBeGreaterThanOrEqual(5000);
    });
});

describe('walking a set the server paged smaller than requested', () => {
    /**
     * Asking for a bigger page than the server allows must not break the walk.
     * The arithmetic follows `returned`, so a server that caps silently just
     * takes more pages -- which is what makes guessing the page size safe.
     */
    it('follows what came back rather than what was asked for', async () => {
        const pages = [page(0, 2, 5), page(2, 2, 5), page(4, 1, 5)];

        const result = await collectAllPages(
            asPage(pages[0])!,
            async (position) => pages.find((candidate) => candidate.position === position),
            'search_emails'
        );

        expect(result.returned).toBe(5);
        expect(result.pages).toBe(3);
    });
});
