/**
 * Email search tools for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email, EmailFilter, EmailSummary } from 'jmap-courier';

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
export const searchEmailsSchema = z.object({
    mailbox: z.string().optional().describe('Mailbox to search in. Omit to search all mail EXCEPT Junk and Trash, which is usually what you want. Pass "Inbox" when the question is specifically about the inbox ("do I have new mail?", "what is my latest unread message?"), since mail filed into other folders would otherwise be included. Pass "Junk" or "Trash" explicitly to search those — they are never searched by default. The standard names ("Inbox", "Sent", "Drafts", "Archive", "Junk", "Trash") always find the right folder whatever the provider calls it — "Junk" finds a folder named "Spam". Any other folder is matched by name, or by full path ("migrated/Junk") when the name is ambiguous.'),
    query: z.string().optional().describe('Full-text search query (use sparingly; can expand results).'),
    from: z.string().optional().describe('Filter by sender email or name'),
    to: z.string().optional().describe('Filter by recipient email or name'),
    subject: z.string().optional().describe('Filter by subject text'),
    after: z.string().optional().describe('Only emails after this date (ISO 8601 format, e.g., "2024-01-01")'),
    before: z.string().optional().describe('Only emails before this date (ISO 8601 format)'),
    hasAttachment: z.boolean().optional().describe('Filter by attachment presence'),
    isUnread: z.boolean().optional().describe('Filter by unread status'),
    limit: z.coerce.number().finite().optional().default(20).describe('Results per page (default 20, max 100 -- a larger value is capped, not honoured). Lower = fewer tokens.'),
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
    const filter: EmailFilter = {};

    // Handle mailbox filter
    if (params.mailbox) {
        const mailbox = await client.resolveMailbox(params.mailbox);
        if (mailbox) {
            filter.inMailbox = mailbox.id;
        } else {
            throw new Error(`Mailbox not found: ${params.mailbox}`);
        }
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
            filter.inMailboxOtherThan = excluded;
        }
    }

    if (params.query) {
        filter.text = params.query;
    }
    if (params.from) {
        filter.from = params.from;
    }
    if (params.to) {
        filter.to = params.to;
    }
    if (params.subject) {
        filter.subject = params.subject;
    }
    if (params.after) {
        filter.after = new Date(params.after).toISOString();
    }
    if (params.before) {
        filter.before = new Date(params.before).toISOString();
    }
    if (params.hasAttachment !== undefined) {
        filter.hasAttachment = params.hasAttachment;
    }
    if (params.isUnread === true) {
        filter.notKeyword = '$seen';
    } else if (params.isUnread === false) {
        filter.hasKeyword = '$seen';
    }

    // The cap stays: these results go into a model's context window, so an
    // unbounded page is the harm it exists to prevent. What changes is that a
    // truncated set now says so, via total/hasMore, instead of looking complete.
    const limit = Math.min(params.limit || 20, 100);
    const position = Math.max(0, Math.trunc(params.position || 0));

    // Query for email IDs
    const page = await client.queryEmailsPage(
        Object.keys(filter).length > 0 ? filter : undefined,
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
