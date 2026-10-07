/**
 * Walking a result set that does not fit in one page.
 *
 * Courier caps a search at 100 matches per call and reports `total`,
 * `position`, `returned` and `hasMore` so a caller can see that a set was
 * truncated. Every consumer then writes the same loop, and the loop is easy to
 * write wrongly in one specific way: fetch pages, hit an error on page four,
 * return the three you have. The result is well-formed, plausible, and smaller
 * than the truth.
 *
 * So `--all` here is all-or-nothing. If any page fails, or the page cap is
 * reached before the set is exhausted, the pages already collected are
 * discarded and the command exits `incomplete`. A caller never has to ask
 * whether the array it was handed is the whole answer.
 */

import { CliError, EXIT } from './exit.js';

/** Default ceiling on pages, so `--all` on a huge mailbox cannot run unbounded. */
export const DEFAULT_MAX_PAGES = 50;

/**
 * Page size `--all` asks for when the caller did not choose one.
 *
 * Someone who typed `--all` has already said they want everything, so the
 * tool's own default page size -- tuned for a model that pays per token -- is
 * the wrong trade entirely. It buys nothing and costs round trips and ceiling:
 * a consumer measured 434 messages at 22 requests and 8.0s with the default 20,
 * against 5 requests and 2.1s at 100. Worse, 20 x DEFAULT_MAX_PAGES caps
 * `--all` at 1000 results, which is high enough to look correct on anything
 * small and silently too low on a real mailbox.
 *
 * Used only when the tool's schema does not advertise a `maximum`. Asking for
 * more than the server allows is harmless: Courier caps the value rather than
 * rejecting it, and the walk follows `returned` rather than what it requested,
 * so a server that gives back less simply takes more pages.
 */
export const DEFAULT_ALL_PAGE_SIZE = 100;

/**
 * The page size to request for `--all`, given the tool's schema.
 *
 * Prefers a `maximum` the schema actually advertises over the constant above,
 * so a server that publishes its cap is believed rather than guessed at.
 */
export function pageSizeForAll(limitSchema?: { maximum?: unknown }): number {
    const maximum = limitSchema?.maximum;
    return typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0
        ? maximum
        : DEFAULT_ALL_PAGE_SIZE;
}

export interface Page {
    total: number;
    position: number;
    returned: number;
    hasMore: boolean;
    /** The array of items -- `emails` for search_emails. Found by shape, not by name. */
    itemsKey: string;
    items: unknown[];
    raw: Record<string, unknown>;
}

/**
 * Reads a result as a page, or returns undefined when it is not one.
 *
 * Requires every paging field to be present and well-typed. A result missing
 * one is not treated as a single complete page -- that assumption is how a
 * partial answer would come to look total -- it simply is not pageable, and
 * `--all` says so rather than guessing.
 */
export function asPage(payload: unknown): Page | undefined {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;

    const record = payload as Record<string, unknown>;
    const { total, position, returned, hasMore } = record;
    if (
        typeof total !== 'number' ||
        typeof position !== 'number' ||
        typeof returned !== 'number' ||
        typeof hasMore !== 'boolean'
    ) {
        return undefined;
    }

    // The item array is whichever array has as many entries as `returned` says
    // were returned. Keyed by shape rather than by a hardcoded `emails`, so a
    // future paged tool with a differently named array needs no change here.
    const itemsEntry = Object.entries(record).find(
        ([, value]) => Array.isArray(value) && value.length === returned
    );
    if (!itemsEntry) return undefined;

    return {
        total,
        position,
        returned,
        hasMore,
        itemsKey: itemsEntry[0],
        items: itemsEntry[1] as unknown[],
        raw: record,
    };
}

export interface PagingOptions {
    maxPages?: number;
    /** Called with each page fetched, for progress on stderr. */
    onPage?: (fetched: number, total: number) => void;
}

/**
 * Collects every page of a result set.
 *
 * `fetchPage` is handed the position to request. Any error it throws propagates
 * unchanged -- an unreachable server stays `unreachable` rather than being
 * relabelled `incomplete`, because the two call for different responses.
 */
export async function collectAllPages(
    first: Page,
    fetchPage: (position: number) => Promise<unknown>,
    toolName: string,
    options: PagingOptions = {}
): Promise<Record<string, unknown>> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const items = [...first.items];
    let page = first;
    let pagesFetched = 1;

    options.onPage?.(items.length, first.total);

    while (page.hasMore) {
        if (pagesFetched >= maxPages) {
            throw new CliError(
                EXIT.INCOMPLETE,
                `${toolName} has ${page.total} matches and --all stopped after ${pagesFetched} pages ` +
                    `(${items.length} collected). The partial set was discarded rather than printed as a complete answer.`,
                `Raise --max-pages, or narrow the query.`
            );
        }

        const nextPosition = page.position + page.returned;
        // A page that returns nothing while claiming more exist would loop
        // forever. Treat it as incomplete: the set cannot be walked, and
        // printing what we have would misreport it as whole.
        if (page.returned === 0) {
            throw new CliError(
                EXIT.INCOMPLETE,
                `${toolName} reported more results at position ${nextPosition} but returned none, so the set cannot be walked. ` +
                    `The ${items.length} collected were discarded rather than printed as a complete answer.`
            );
        }

        const next = asPage(await fetchPage(nextPosition));
        if (!next) {
            throw new CliError(
                EXIT.INCOMPLETE,
                `${toolName} stopped reporting paging fields part way through, so the set cannot be walked. ` +
                    `The ${items.length} collected were discarded rather than printed as a complete answer.`
            );
        }

        items.push(...next.items);
        page = next;
        pagesFetched += 1;
        options.onPage?.(items.length, page.total);
    }

    // Measured against the LAST page's total, not the first.
    //
    // A set that changed mid-walk is not an error in itself: mail arrives
    // constantly, and refusing every search that raced an arrival would make
    // --all useless. What cannot be allowed through is a count that does not
    // add up -- pages that stopped short of the total they declared -- because
    // there the array looks entirely plausible and the count is the only
    // evidence that anything was missed.
    //
    // This is as far as the check can honestly go. Detecting every mutation
    // would need a stable query state across calls, which the tool does not
    // expose; the gap is that a deletion early in the set can shift positions
    // and skip an item while the arithmetic still balances.
    if (items.length !== page.total) {
        throw new CliError(
            EXIT.INCOMPLETE,
            `${toolName} reported ${page.total} matches but ${items.length} were collected, so the set changed while it was being read. ` +
                'The partial set was discarded rather than printed as a complete answer.',
            'Retry, or narrow the query so the set is stable.'
        );
    }

    return {
        ...page.raw,
        [page.itemsKey]: items,
        position: first.position,
        returned: items.length,
        hasMore: false,
        pages: pagesFetched,
    };
}
