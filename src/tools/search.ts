/**
 * Email search tools for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email, EmailFilterExpression, EmailSummary } from 'jmap-courier';

// Tool schemas
/**
 * Numeric tool inputs are coerced rather than strictly typed.
 *
 * MCP clients routinely send a JSON string where the schema says number --
 * observed live, a client sent position as "0" and the call was rejected with a
 * validation error the user could do nothing about. The tool contract is what
 * the client can express, not what we would prefer, so accept both.
 *
 * `.finite()` covers what coercion lets through: Number("Infinity") is a valid
 * number and would reach the JMAP query as a position. A non-numeric string is
 * already rejected by coercion itself, so that case needs nothing extra.
 */
/**
 * A filter that takes one value or several.
 *
 * Several means OR. Every such parameter used to take exactly one value, so
 * "mail from any of these ten senders" was ten searches -- a consumer measured
 * its whole 26.8s full fetch as eleven paged queries that one OR collapses into
 * two. JMAP has supported the combination since RFC 8620; nothing exposed it.
 */
const oneOrMore = z.union([z.string(), z.array(z.string()).min(1)]).optional();

/**
 * Largest page this tool will return.
 *
 * Declared in the schema, not only in prose, so a caller can derive it. It used
 * to live in the description alone and the handler silently clamped anything
 * larger -- which meant a client asking for 200 received 100 with no indication,
 * and anything wanting to page optimally had to parse English or guess. The
 * CLI guesses 100 to this day for exactly that reason.
 *
 * Rejecting rather than clamping is the same rule the rest of this server
 * follows: an answer quietly smaller than the one requested is the failure mode
 * this project keeps producing. A caller that asks for more is told so and can
 * page.
 */
export const MAX_PAGE_SIZE = 100;

export const searchEmailsSchema = z.object({
    mailbox: oneOrMore.describe('Mailbox to search in. Accepts a list to search several at once. Omit to search all mail EXCEPT Junk and Trash, which is usually what you want. Pass "Inbox" when the question is specifically about the inbox ("do I have new mail?", "what is my latest unread message?"), since mail filed into other folders would otherwise be included. Pass "Junk" or "Trash" explicitly to search those — they are never searched by default. The standard names ("Inbox", "Sent", "Drafts", "Archive", "Junk", "Trash") always find the right folder whatever the provider calls it — "Junk" finds a folder named "Spam". Any other folder is matched by name, or by full path ("migrated/Junk") when the name is ambiguous.'),
    query: z.string().optional().describe('Full-text search query (use sparingly; can expand results).'),
    from: oneOrMore
        .describe(
            'Filter by sender. PASS A LIST to match any of several senders in ONE call instead of one search each -- "from any of these" is the single biggest saving available here. Matches WHOLE WORDS, not substrings: "guidepoint" finds guidepoint.com but NOT guidepointglobal.com, because the provider tokenises on punctuation. Pass the full domain or address when you mean one specific sender, and list every variant when a company uses several.'
        ),
    to: oneOrMore.describe(
        'Filter by recipient. Accepts a list, matching any of them. Matches whole words, not substrings -- see `from`.'
    ),
    cc: oneOrMore.describe('Filter by CC recipient. Accepts a list, matching any of them.'),
    participant: oneOrMore.describe(
        'Filter by anyone involved, whether they sent it or appear in To, Cc or Bcc. Use this for "did I correspond with X" rather than guessing which field they were in. Accepts a list.'
    ),
    hasKeyword: oneOrMore.describe(
        'Only messages carrying this keyword/tag (e.g. a label set by tag_emails). Accepts a list, matching any of them.'
    ),
    lacksKeyword: oneOrMore.describe(
        'Only messages NOT carrying this keyword/tag. Accepts a list; a message carrying any of them is excluded.'
    ),
    subject: z
        .string()
        .optional()
        .describe('Filter by subject. Matches whole words, not substrings -- see `from`.'),
    after: z.string().optional().describe('Only emails after this date (ISO 8601 format, e.g., "2024-01-01")'),
    before: z.string().optional().describe('Only emails before this date (ISO 8601 format)'),
    hasAttachment: z.boolean().optional().describe('Filter by attachment presence'),
    isUnread: z.boolean().optional().describe('Filter by unread status'),
    limit: z
        .coerce
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .optional()
        .default(20)
        .describe(
            `Results per page (default 20, max ${MAX_PAGE_SIZE}). Lower = fewer tokens. A larger value is REJECTED rather than capped, so a caller is never silently handed less than it asked for; page with position instead.`
        ),
    position: z.coerce.number().finite().optional().default(0).describe('Zero-based offset into the matching set, for paging. Combine with the returned total/hasMore to walk a result set larger than one page; keep the other filters identical between calls.'),
});

/**
 * The shape every summary-returning tool hands back.
 *
 * Exported so the change feed produces byte-identical rows to a search. A
 * message arriving through two doors with two shapes is a needless source of
 * caller bugs.
 */
export function toEmailSummary(email: Email): EmailSummary {
    return {
        id: email.id,
        threadId: email.threadId,
        messageId: email.messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        subject: email.subject,
        from: email.from,
        to: email.to,
        receivedAt: email.receivedAt,
        preview: email.preview,
        hasAttachment: email.hasAttachment,
        isRead: email.keywords?.['$seen'] === true,
        isFlagged: email.keywords?.['$flagged'] === true,
    };
}

/** One value or many, always as a list. */
function asList(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
}

/**
 * OR over several conditions, or the condition itself when there is only one.
 *
 * Unwrapping the single case keeps the filter JMAP sees identical to what it
 * saw before this existed, so a query that was already correct cannot change
 * shape -- and the server's query planner is handed nothing to see through.
 */
function anyOf(conditions: EmailFilterExpression[]): EmailFilterExpression {
    if (conditions.length === 1) return conditions[0];
    return { operator: 'OR', conditions };
}

// Tool handlers
export async function searchEmails(
    params: z.infer<typeof searchEmailsSchema>
): Promise<{
    emails: EmailSummary[];
    /** How many messages match the filter, not how many are in this page. */
    total: number;
    /** Offset of this page into that set. */
    position: number;
    /** Size of this page. Differs from `total` whenever the set was truncated. */
    returned: number;
    /** True when messages match beyond this page. */
    hasMore: boolean;
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);

    // Build filter

    // Every parameter below contributes one condition; they are ANDed together,
    // and a parameter given several values becomes an OR among those values.
    // Built as an expression tree rather than a flat object because JMAP has no
    // other way to say "any of these senders", which is the whole point.
    const conditions: EmailFilterExpression[] = [];

    if (params.mailbox) {
        const names = asList(params.mailbox);
        const mailboxes = await Promise.all(names.map((name) => client.resolveMailbox(name)));
        const missing = names.filter((_, index) => mailboxes[index] === null);
        if (missing.length > 0) {
            // Named and refused rather than quietly skipped. A search that
            // silently dropped one of three mailboxes would return a smaller
            // answer that looks complete.
            throw new Error(`Mailbox not found: ${missing.join(', ')}`);
        }
        conditions.push(
            anyOf(
                mailboxes
                    .filter((mailbox): mailbox is NonNullable<typeof mailbox> => mailbox !== null)
                    .map((mailbox) => ({ inMailbox: mailbox.id }))
            )
        );
    } else {
        // An unscoped JMAP query spans every mailbox, so "my latest unread
        // message" would happily return spam. Exclude Junk and Trash the way
        // every mail client does, while still searching Archive, Sent and
        // custom folders. Naming either mailbox explicitly above opts back in.
        const excluded = (
            await Promise.all([client.getMailboxByRole('junk'), client.getMailboxByRole('trash')])
        )
            .filter((mailbox): mailbox is NonNullable<typeof mailbox> => mailbox !== null)
            .map((mailbox) => mailbox.id);
        if (excluded.length > 0) {
            conditions.push({ inMailboxOtherThan: excluded });
        }
    }

    if (params.query) {
        conditions.push({ text: params.query });
    }
    for (const [field, value] of [
        ['from', params.from],
        ['to', params.to],
        ['cc', params.cc],
    ] as const) {
        if (value) conditions.push(anyOf(asList(value).map((entry) => ({ [field]: entry }))));
    }

    // Anyone involved, whichever field they appeared in. JMAP has no such
    // filter, so it is an OR across the four that exist -- which is exactly the
    // kind of thing a caller should not have to assemble by hand, and the
    // reason "did I correspond with X" was previously three searches.
    if (params.participant) {
        conditions.push(
            anyOf(
                asList(params.participant).flatMap((entry) => [
                    { from: entry },
                    { to: entry },
                    { cc: entry },
                    { bcc: entry },
                ])
            )
        );
    }

    if (params.subject) {
        conditions.push({ subject: params.subject });
    }
    if (params.after) {
        conditions.push({ after: new Date(params.after).toISOString() });
    }
    if (params.before) {
        conditions.push({ before: new Date(params.before).toISOString() });
    }
    if (params.hasAttachment !== undefined) {
        conditions.push({ hasAttachment: params.hasAttachment });
    }
    if (params.isUnread === true) {
        conditions.push({ notKeyword: '$seen' });
    } else if (params.isUnread === false) {
        conditions.push({ hasKeyword: '$seen' });
    }
    if (params.hasKeyword) {
        conditions.push(anyOf(asList(params.hasKeyword).map((keyword) => ({ hasKeyword: keyword }))));
    }
    if (params.lacksKeyword) {
        // NOT over an OR: carrying ANY of them excludes the message, which is
        // what "lacks all of these" means and what a caller listing several
        // unwanted tags intends.
        conditions.push({
            operator: 'NOT',
            conditions: [anyOf(asList(params.lacksKeyword).map((keyword) => ({ hasKeyword: keyword })))],
        });
    }

    const filter: EmailFilterExpression | undefined =
        conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };

    // The cap stays: these results go into a model's context window, so an
    // unbounded page is the harm it exists to prevent. What changes is that a
    // truncated set now says so, via total/hasMore, instead of looking complete.
    // Already bounded by the schema; this only applies the default.
    const limit = params.limit || 20;
    const position = Math.max(0, Math.trunc(params.position || 0));

    // Query for email IDs
    const page = await client.queryEmailsPage(
        filter,
        [{ property: 'receivedAt', isAscending: false }],
        { limit, position }
    );

    // Fetch email details
    const emails = await client.getEmails(page.ids);

    const summaries: EmailSummary[] = emails.map(toEmailSummary);

    return {
        emails: summaries,
        // Previously this reported summaries.length -- the page size wearing the
        // name of the match count. A caller with 49 matches saw "total: 20" and
        // had nothing to tell it the other 29 existed.
        total: page.total,
        position: page.position,
        returned: summaries.length,
        hasMore: page.position + summaries.length < page.total,
        account: manager.getCurrentAccountName(),
    };
}
