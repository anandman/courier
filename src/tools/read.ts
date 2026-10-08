/**
 * Email read tool for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { EmailAddress } from 'jmap-courier';

// Tool schemas
export const getEmailSchema = z.object({
    emailId: z.string().describe('The ID of the email to retrieve (use after search_emails to minimize tokens)'),
    markAsRead: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            'Mark the message read as a side effect. Defaults to FALSE: reading a message to triage it should not change what the human sees as unread, and unread state is itself triage signal. Pass true only when the read is on a person\'s behalf.'
        ),
});

// Helper to format email addresses
function formatAddresses(addresses: EmailAddress[] | null): string {
    if (!addresses || addresses.length === 0) return '';
    return addresses.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
}

// Tool handlers
export async function getEmail(
    params: z.infer<typeof getEmailSchema>
): Promise<{
    id: string;
    threadId: string;
    messageId: string[] | null;
    inReplyTo: string[] | null;
    references: string[] | null;
    subject: string | null;
    from: string;
    to: string;
    cc: string;
    replyTo: string;
    date: string;
    body: string;
    htmlBody: string | null;
    hasAttachment: boolean;
    attachments: Array<{ blobId: string | null; name: string | null; type: string; size: number }>;
    keywords: string[];
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const email = await client.getEmailWithBody(params.emailId);

    // Extract text body
    let textBody = '';
    if (email.bodyValues && email.textBody && email.textBody.length > 0) {
        const partId = email.textBody[0].partId;
        if (partId && email.bodyValues[partId]) {
            textBody = email.bodyValues[partId].value;
        }
    }

    // Extract HTML body
    let htmlBody: string | null = null;
    if (email.bodyValues && email.htmlBody && email.htmlBody.length > 0) {
        const partId = email.htmlBody[0].partId;
        if (partId && email.bodyValues[partId]) {
            htmlBody = email.bodyValues[partId].value;
        }
    }

    // If no text body but has HTML, use preview
    if (!textBody && !htmlBody) {
        textBody = email.preview;
    }

    // Extract attachments
    const attachments = (email.attachments || []).map(att => ({
        // blobId is what get_attachment needs to choose between several
        // attachments. Without it the two tools did not compose, and a caller
        // with a multi-attachment message had no way to name the one it meant.
        blobId: att.blobId,
        name: att.name,
        type: att.type,
        size: att.size,
    }));

    // Extract keywords (excluding system keywords for cleaner display)
    const keywords = Object.keys(email.keywords || {});

    // Mark as read if requested
    if (params.markAsRead && !email.keywords?.['$seen']) {
        await client.markEmailsRead([email.id], true);
    }

    return {
        id: email.id,
        threadId: email.threadId,
        // Raw JMAP shape on purpose: a pre-built message:// URL would hide the
        // null case, and a caller that cannot see the absence cannot fall back.
        messageId: email.messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        subject: email.subject,
        from: formatAddresses(email.from),
        to: formatAddresses(email.to),
        cc: formatAddresses(email.cc),
        replyTo: formatAddresses(email.replyTo),
        date: email.sentAt || email.receivedAt,
        body: textBody,
        htmlBody,
        hasAttachment: email.hasAttachment,
        attachments,
        keywords,
        account: manager.getCurrentAccountName(),
    };
}

/** How much of each body to return when the caller does not say. */
const DEFAULT_BODY_CHARS = 4000;
const MAX_EMAILS_PER_CALL = 50;

export const getEmailsSchema = z.object({
    emailIds: z
        .array(z.string())
        .min(1)
        .max(MAX_EMAILS_PER_CALL)
        .describe(
            `Messages to fetch, up to ${MAX_EMAILS_PER_CALL}. Shortlist with search_emails first; this is for reading the few you chose, not for sweeping a mailbox.`
        ),
    includeBodies: z
        .boolean()
        .optional()
        .default(true)
        .describe('Set false for headers only, which is far cheaper when you are only classifying.'),
    maxBodyChars: z
        .coerce
        .number()
        .int()
        .min(0)
        .optional()
        .default(DEFAULT_BODY_CHARS)
        .describe(
            `Characters of body text per message (default ${DEFAULT_BODY_CHARS}). A longer body is cut and the message says so. 0 means no body at all.`
        ),
    includeHtml: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include the HTML body as well. Off by default: it is usually several times the size of the text and says the same thing.'),
});

export interface BatchEmail {
    id: string;
    threadId: string;
    messageId: string[] | null;
    inReplyTo: string[] | null;
    references: string[] | null;
    subject: string | null;
    from: string;
    to: string;
    cc: string;
    date: string;
    isRead: boolean;
    hasAttachment: boolean;
    attachments: Array<{ blobId: string | null; name: string | null; type: string; size: number }>;
    keywords: string[];
    body?: string;
    htmlBody?: string | null;
    /** True when `body` was cut short. The full length is in `bodyChars`. */
    bodyTruncated?: boolean;
    bodyChars?: number;
}

/**
 * Fetches several messages in one call, returning only what was asked for.
 *
 * get_email answers one message at a time with everything it has, which makes
 * reading a shortlist of twenty a round trip each. A consumer measured 0.38s
 * and 18 KB per message and parsed about 400 bytes of it -- so the cost is
 * mostly in fetching and carrying body text nobody reads, and it is paid again
 * every time an extraction rule changes.
 *
 * Both halves of that are addressed here: one request for the batch, and
 * control over how much of each message comes back. The body cap is a character
 * count rather than a flag because the useful setting is usually "the first
 * screenful", and a truncated body says so rather than looking complete.
 *
 * Never marks anything read. The single-message tool has an explicit option for
 * that; a batch read is a survey by definition, and a survey that consumed
 * unread state across twenty messages would be the same bug twenty times.
 */
export async function getEmails(
    params: z.infer<typeof getEmailsSchema>
): Promise<{
    emails: BatchEmail[];
    requested: number;
    returned: number;
    /** Ids that were asked for and not returned, usually because they no longer exist. */
    missing: string[];
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const wantBodies = params.includeBodies && params.maxBodyChars > 0;
    const emails = wantBodies
        ? await client.getEmailsWithBodies(params.emailIds)
        : await client.getEmails(params.emailIds);

    const found = new Set(emails.map((email) => email.id));
    const results: BatchEmail[] = emails.map((email) => {
        const base: BatchEmail = {
            id: email.id,
            threadId: email.threadId,
            messageId: email.messageId,
            inReplyTo: email.inReplyTo,
            references: email.references,
            subject: email.subject,
            from: formatAddresses(email.from),
            to: formatAddresses(email.to),
            cc: formatAddresses(email.cc),
            date: email.receivedAt,
            isRead: email.keywords?.['$seen'] === true,
            hasAttachment: email.hasAttachment,
            attachments: (email.attachments ?? []).map((attachment) => ({
                blobId: attachment.blobId,
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
            })),
            keywords: Object.keys(email.keywords ?? {}),
        };

        if (!wantBodies) return base;

        const text = bodyText(email) || email.preview || '';
        const truncated = text.length > params.maxBodyChars;
        return {
            ...base,
            body: truncated ? text.slice(0, params.maxBodyChars) : text,
            bodyChars: text.length,
            // Stated on every message with a body, not only the cut ones, so a
            // caller can tell "short message" from "cut to the same length".
            bodyTruncated: truncated,
            ...(params.includeHtml ? { htmlBody: bodyHtml(email) } : {}),
        };
    });

    return {
        emails: results,
        requested: params.emailIds.length,
        returned: results.length,
        // Named rather than silently absent. A caller that asked for twenty and
        // got eighteen has no way to tell which two are missing from a list that
        // looks complete.
        missing: params.emailIds.filter((id) => !found.has(id)),
        account: manager.getCurrentAccountName(),
    };
}

function bodyText(email: { bodyValues?: Record<string, { value: string }>; textBody?: { partId: string | null }[] }): string {
    const partId = email.textBody?.[0]?.partId;
    return partId && email.bodyValues?.[partId] ? email.bodyValues[partId].value : '';
}

function bodyHtml(email: { bodyValues?: Record<string, { value: string }>; htmlBody?: { partId: string | null }[] }): string | null {
    const partId = email.htmlBody?.[0]?.partId;
    return partId && email.bodyValues?.[partId] ? email.bodyValues[partId].value : null;
}
