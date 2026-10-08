/**
 * Email send and forward tools for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';

// Helper to normalize email addresses to array
function normalizeEmails(input: string | string[] | undefined): string[] {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    // Split by comma or semicolon
    return input.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);
}

// Tool schemas
export const sendEmailSchema = z.object({
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text). Keep concise if token usage matters.'),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
    replyTo: z.string().optional().describe('Reply-to address'),
    isHtml: z.boolean().optional().default(false).describe('Whether body is HTML (default false)'),
});

export const forwardEmailSchema = z.object({
    emailId: z.string().describe('ID of the email to forward (use IDs from search_emails)'),
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
    comment: z.string().optional().describe('Optional comment to add before forwarded content'),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
});

// Tool handlers
export async function sendEmail(
    params: z.infer<typeof sendEmailSchema>
): Promise<{
    success: boolean;
    emailId: string;
    message: string;
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);

    const toAddresses = normalizeEmails(params.to);
    if (toAddresses.length === 0) {
        throw new Error('At least one recipient is required');
    }

    const result = await client.sendEmail({
        to: toAddresses,
        subject: params.subject,
        textBody: params.isHtml ? '' : params.body,
        htmlBody: params.isHtml ? params.body : undefined,
        cc: normalizeEmails(params.cc),
        bcc: normalizeEmails(params.bcc),
        replyTo: params.replyTo,
    });

    return {
        success: true,
        emailId: result.emailId,
        message: `Email sent successfully to ${toAddresses.join(', ')}`,
        account: manager.getCurrentAccountName(),
    };
}

export async function forwardEmail(
    params: z.infer<typeof forwardEmailSchema>
): Promise<{
    success: boolean;
    emailId: string;
    message: string;
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);

    const toAddresses = normalizeEmails(params.to);
    if (toAddresses.length === 0) {
        throw new Error('At least one recipient is required');
    }

    const result = await client.forwardEmail({
        originalEmailId: params.emailId,
        to: toAddresses,
        comment: params.comment,
        cc: normalizeEmails(params.cc),
        bcc: normalizeEmails(params.bcc),
    });

    return {
        success: true,
        emailId: result.emailId,
        message: `Email forwarded successfully to ${toAddresses.join(', ')}`,
        account: manager.getCurrentAccountName(),
    };
}

export const sendDraftSchema = z.object({
    emailId: z
        .string()
        .describe(
            'The draft to send, exactly as it stands. Use the emailId a draft tool returned. Note that update_draft REPLACES a draft and issues a new id, so an id from before a revision is stale and will be refused -- which is the point: it cannot send a version nobody reviewed.'
        ),
});

export interface SendDraftResult {
    sent: true;
    emailId: string;
    submissionId: string;
    to: string[];
    subject: string;
    message: string;
    account: string | null;
}

/**
 * Sends a draft that already exists, unchanged.
 *
 * The difference from send_email is the entire reason this exists. That one
 * composes and sends in one step, so nothing is ever reviewable: there is no
 * moment at which a person could read what is about to go out. This sends the
 * exact message sitting in Drafts -- with the recipients, attachments and
 * threading it already has, and with whatever edits a human made to it.
 *
 * That makes draft -> read -> send possible, which is the only shape in which
 * an agent sending mail is a reasonable thing to permit.
 *
 * There is no idempotency key and none is needed, because the draft id is
 * already one. Sending moves the message out of Drafts, so a second call with
 * the same id is refused rather than sending twice; and update_draft replaces a
 * draft with a new id, so an id captured before a revision cannot send the
 * version nobody looked at.
 */
export async function sendDraft(
    params: z.infer<typeof sendDraftSchema>
): Promise<SendDraftResult> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    // Read before sending, so the result can say what went out. Afterwards the
    // message has moved to Sent and its draft identity is gone.
    const [draft] = await client.getEmails([params.emailId]);
    const to = (draft?.to ?? []).map((address) => address.email).filter(Boolean);
    const subject = draft?.subject ?? '';

    const { submissionId } = await client.sendDraft(params.emailId);

    return {
        sent: true,
        emailId: params.emailId,
        submissionId,
        to,
        subject,
        message: `Sent. The message has left Drafts and been filed in Sent; this cannot be undone, and ${params.emailId} can no longer be sent again.`,
        account: manager.getCurrentAccountName(),
    };
}
