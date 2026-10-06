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
    markAsRead: z.boolean().optional().default(true).describe('Whether to mark the email as read (default true)'),
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
