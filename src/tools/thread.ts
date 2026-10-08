/**
 * Read a whole conversation, and read what is attached to a message.
 *
 * Both existed only as N-calls-and-reassemble. Following a thread meant one
 * get_email per message plus sorting them yourself; an attachment could be seen
 * (`{name, type, size}`) but never opened, so an agent could tell you an invoice
 * had arrived and not what was in it.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email } from 'jmap-courier';

/** Attachment bytes are returned inline, so this is a context budget. */
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;

export const readThreadSchema = z.object({
    threadId: z.string().describe('Thread id, from the threadId on any search_emails result.'),
    includeBodies: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include message bodies. Set false for a cheap outline of who said what, when.'),
    limit: z.coerce
        .number()
        .finite()
        .optional()
        .default(50)
        .describe(
            'Maximum messages to return. A longer thread is truncated to the MOST RECENT this many, still presented oldest-first, and says so via total/returned/truncated.'
        ),
});

export const getAttachmentSchema = z.object({
    emailId: z.string().describe('The message holding the attachment.'),
    blobId: z
        .string()
        .optional()
        .describe('Which attachment, from get_email. Omit when the message has exactly one.'),
    maxBytes: z.coerce
        .number()
        .finite()
        .optional()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Cap on bytes returned (default ${DEFAULT_MAX_BYTES}, hard limit ${HARD_MAX_BYTES}). Content is returned inline, so this is a context budget.`),
});

function clientFor() {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }
    return { client: getClient(account), manager };
}

function bodyOf(email: Email): string {
    if (email.bodyValues && email.textBody?.length) {
        const partId = email.textBody[0].partId;
        if (partId && email.bodyValues[partId]) return email.bodyValues[partId].value;
    }
    return email.preview ?? '';
}

export async function readThread(params: z.infer<typeof readThreadSchema>) {
    const { client, manager } = clientFor();
    const all = await client.getThread(params.threadId, { withBodies: params.includeBodies });

    // Truncate from the FRONT, keeping the most recent messages.
    //
    // Thread/get returns ids in received order, so taking the first N dropped
    // the newest replies -- the part of a conversation most likely to matter,
    // and the part a caller asking for "the thread" is usually after. A
    // 50-message thread read with limit 20 showed the oldest 20 and hid
    // everything since, while reporting a cheerful total. Reading order is
    // still oldest-first within what is returned.
    const kept = all.length > params.limit ? all.slice(all.length - params.limit) : all;

    const messages = kept.map((email) => ({
        id: email.id,
        messageId: email.messageId,
        from: email.from,
        to: email.to,
        cc: email.cc,
        receivedAt: email.receivedAt,
        subject: email.subject,
        isRead: email.keywords?.['$seen'] === true,
        hasAttachment: email.hasAttachment,
        attachments: (email.attachments ?? []).map((a) => ({
            blobId: a.blobId,
            name: a.name ?? null,
            type: a.type ?? null,
            size: a.size ?? null,
        })),
        ...(params.includeBodies ? { body: bodyOf(email) } : {}),
    }));

    return {
        threadId: params.threadId,
        // The count of the conversation, not of this page — the distinction this
        // codebase has had to relearn repeatedly.
        total: all.length,
        returned: messages.length,
        truncated: all.length > messages.length,
        messages,
        account: manager.getCurrentAccountName(),
    };
}

export async function getAttachment(params: z.infer<typeof getAttachmentSchema>) {
    const { client, manager } = clientFor();
    const email = await client.getEmailWithBody(params.emailId);
    const attachments = email.attachments ?? [];

    if (attachments.length === 0) {
        throw new Error(`Message ${params.emailId} has no attachments.`);
    }

    // Guessing which attachment was meant is how the wrong file gets read.
    let chosen = attachments[0];
    if (params.blobId) {
        const match = attachments.find((a) => a.blobId === params.blobId);
        if (!match) {
            throw new Error(
                `No attachment with blobId "${params.blobId}" on that message. Available: ` +
                    attachments.map((a) => `${a.name ?? 'unnamed'} (${a.blobId})`).join(', ')
            );
        }
        chosen = match;
    } else if (attachments.length > 1) {
        throw new Error(
            `That message has ${attachments.length} attachments; pass blobId to choose one: ` +
                attachments.map((a) => `${a.name ?? 'unnamed'} (${a.blobId})`).join(', ')
        );
    }

    if (!chosen.blobId) throw new Error('That attachment has no blobId and cannot be downloaded.');

    const maxBytes = Math.min(params.maxBytes, HARD_MAX_BYTES);
    const { bytes, contentType, truncated } = await client.downloadBlob(chosen.blobId, {
        type: chosen.type ?? undefined,
        name: chosen.name ?? undefined,
        maxBytes,
    });

    // Text is far more useful as text; everything else has to be base64 to
    // survive a JSON response at all.
    const isText = /^text\/|application\/(json|xml|javascript)|\+xml$|\+json$/.test(contentType);

    return {
        emailId: params.emailId,
        blobId: chosen.blobId,
        name: chosen.name ?? null,
        type: contentType,
        size: chosen.size ?? null,
        encoding: isText ? ('text' as const) : ('base64' as const),
        bytesReturned: bytes.byteLength,
        truncated,
        content: isText ? bytes.toString('utf8') : bytes.toString('base64'),
        message: truncated
            ? `Truncated to ${bytes.byteLength} of ${chosen.size ?? 'unknown'} bytes — raise maxBytes for the rest.`
            : 'Complete.',
        account: manager.getCurrentAccountName(),
    };
}
