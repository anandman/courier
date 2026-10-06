/**
 * Create a draft without sending it.
 *
 * Courier could compose and send, or forward and send, and had no way to leave
 * a message in Drafts for a human to read first. That is the wrong shape for
 * anything a person wants to check before it goes out, and sending is not a
 * smaller version of drafting.
 *
 * Reply mode is why the RFC 5322 identity headers were exposed in September: a
 * reply without In-Reply-To and References opens a new conversation. It looks
 * correct in a Drafts list and wrong in every client that threads.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email, EmailAddress } from 'jmap-courier';

function normalizeEmails(input: string | string[] | undefined): string[] {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    return input.split(/[,;]/).map((e) => e.trim()).filter((e) => e.length > 0);
}

export const draftEmailSchema = z.object({
    mode: z
        .enum(['new', 'reply', 'forward'])
        .optional()
        .default('new')
        .describe(
            'new (default), reply, or forward. reply and forward require emailId and inherit the recipients, subject and threading headers from the original.'
        ),
    emailId: z
        .string()
        .optional()
        .describe('The message being replied to or forwarded. Required for reply and forward.'),
    to: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Recipient(s). Required for new and forward; for reply it defaults to the original sender and may be omitted.'),
    subject: z
        .string()
        .optional()
        .describe('Subject. Required for new; for reply/forward it is derived from the original unless given.'),
    body: z.string().describe('Body text. For reply and forward this goes above the quoted original.'),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipient(s)'),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipient(s)'),
    replyTo: z.string().optional().describe('Reply-to address'),
    replyAll: z
        .boolean()
        .optional()
        .default(false)
        .describe('reply mode only: also address everyone on the original To and Cc.'),
    quote: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include the original message below the body, for reply and forward.'),
});

export interface DraftResult {
    emailId: string;
    mode: 'new' | 'reply' | 'forward';
    to: string[];
    subject: string;
    /** True when the draft carries In-Reply-To, i.e. it will thread. */
    threaded: boolean;
    message: string;
    account: string | null;
}

const addresses = (list: EmailAddress[] | null | undefined): string[] =>
    (list ?? []).map((a) => a.email).filter(Boolean);

/** Body text of an email, or '' when it has none we can read. */
function textOf(email: Email): string {
    if (email.bodyValues && email.textBody?.length) {
        const partId = email.textBody[0].partId;
        if (partId && email.bodyValues[partId]) return email.bodyValues[partId].value;
    }
    return email.preview ?? '';
}

function quoted(email: Email): string {
    const who = (email.from ?? [])[0];
    const when = email.sentAt || email.receivedAt;
    const attribution = `On ${when}, ${who?.name || who?.email || 'someone'} wrote:`;
    const body = textOf(email)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    return `\n\n${attribution}\n${body}`;
}

/** Adds a prefix unless one is already there, so replies do not become "Re: Re: Re:". */
function prefixed(subject: string | null, prefix: 'Re:' | 'Fwd:'): string {
    const base = (subject ?? '').trim();
    if (!base) return prefix.replace(':', '') === 'Re' ? 'Re:' : 'Fwd:';
    return new RegExp(`^${prefix}\\s`, 'i').test(base) ? base : `${prefix} ${base}`;
}

export async function draftEmail(params: z.infer<typeof draftEmailSchema>): Promise<DraftResult> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }
    const client = getClient(account);

    if (params.mode !== 'new' && !params.emailId) {
        throw new Error(`mode "${params.mode}" requires emailId — the message being ${params.mode}d.`);
    }

    let to = normalizeEmails(params.to);
    let cc = normalizeEmails(params.cc);
    let subject = params.subject ?? '';
    let body = params.body;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;

    if (params.mode !== 'new') {
        const original = await client.getEmailWithBody(params.emailId!);

        if (params.mode === 'reply') {
            // Reply-To wins over From: that is what it is for.
            if (to.length === 0) {
                to = addresses(original.replyTo).length
                    ? addresses(original.replyTo)
                    : addresses(original.from);
            }
            if (params.replyAll) {
                const self = (account.name || '').toLowerCase();
                const others = [...addresses(original.to), ...addresses(original.cc)].filter(
                    (a) => a.toLowerCase() !== self && !to.includes(a)
                );
                cc = [...new Set([...cc, ...others])];
            }
            if (!params.subject) subject = prefixed(original.subject, 'Re:');

            // The whole reason the identity headers were exposed. messageId is
            // an array and is genuinely null for some messages, so a reply to
            // one of those is simply unthreaded rather than broken.
            inReplyTo = original.messageId?.[0];
            references = [...(original.references ?? []), ...(original.messageId ?? [])];
        } else {
            if (!params.subject) subject = prefixed(original.subject, 'Fwd:');
        }

        if (params.quote) body = `${body}${quoted(original)}`;
    }

    if (to.length === 0) {
        throw new Error(
            params.mode === 'reply'
                ? 'The original message has no sender to reply to; pass `to` explicitly.'
                : 'At least one recipient is required.'
        );
    }
    if (!subject) throw new Error('A subject is required.');

    const { emailId } = await client.createDraft({
        to,
        subject,
        textBody: body,
        cc: cc.length ? cc : undefined,
        bcc: normalizeEmails(params.bcc).length ? normalizeEmails(params.bcc) : undefined,
        replyTo: params.replyTo,
        inReplyTo,
        references: references?.length ? references : undefined,
    });

    return {
        emailId,
        mode: params.mode,
        to,
        subject,
        threaded: Boolean(inReplyTo),
        message:
            `Draft saved to Drafts. Nothing has been sent.` +
            (params.mode === 'reply' && !inReplyTo
                ? ' Note: the original has no Message-ID, so this reply will not thread.'
                : ''),
        account: manager.getCurrentAccountName(),
    };
}
