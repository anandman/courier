/**
 * Create drafts without sending them.
 *
 * Courier could compose-and-send or forward-and-send, and had nothing in
 * between — the wrong shape for anything a person wants to read before it goes
 * out. Sending is not a smaller version of drafting.
 *
 * Three tools rather than one with a `mode`, because the required arguments
 * genuinely differ: a reply needs a message to reply to and no recipient, a new
 * message needs a recipient and no message. Expressed as one tool, everything
 * has to be optional in the schema, and a caller can construct an invalid call
 * that only fails at runtime. Split, the contract is declarative and the wrong
 * call cannot be made.
 *
 * Reply threading is why the RFC 5322 identity headers were exposed in
 * September: without In-Reply-To and References a reply starts a new
 * conversation, which looks correct in a Drafts list and wrong in every client
 * that threads.
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

const recipients = z.union([z.string(), z.array(z.string())]);
const common = {
    cc: recipients.optional().describe('CC recipient(s)'),
    bcc: recipients.optional().describe('BCC recipient(s)'),
    from: z
        .string()
        .optional()
        .describe(
            'Address to send as. Must be one of this account\'s identities. For a reply it defaults to whichever identity the original was addressed to.'
        ),
};

export const draftEmailSchema = z.object({
    to: recipients.describe('Recipient email address(es)'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    ...common,
});

export const draftReplySchema = z.object({
    emailId: z.string().describe('The message being replied to (use an id from search_emails)'),
    body: z.string().describe('Your reply. Goes above the quoted original.'),
    replyAll: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also address everyone on the original To and Cc, excluding yourself.'),
    quote: z.boolean().optional().default(true).describe('Quote the original below your reply.'),
    to: recipients.optional().describe('Override the recipient. Defaults to the original sender.'),
    ...common,
});

export const draftForwardSchema = z.object({
    emailId: z.string().describe('The message being forwarded (use an id from search_emails)'),
    to: recipients.describe('Recipient email address(es)'),
    body: z.string().optional().default('').describe('Optional note above the forwarded message.'),
    quote: z.boolean().optional().default(true).describe('Include the forwarded message.'),
    ...common,
});

export interface DraftResult {
    emailId: string;
    kind: 'new' | 'reply' | 'forward';
    from: string;
    to: string[];
    subject: string;
    /** True when the draft carries In-Reply-To, i.e. it will thread. */
    threaded: boolean;
    message: string;
    account: string | null;
}

const addresses = (list: EmailAddress[] | null | undefined): string[] =>
    (list ?? []).map((a) => a.email).filter(Boolean);

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
    const body = textOf(email).split('\n').map((l) => `> ${l}`).join('\n');
    return `\n\nOn ${when}, ${who?.name || who?.email || 'someone'} wrote:\n${body}`;
}

/** Adds a prefix once, so a thread does not accumulate "Re: Re: Re:". */
function prefixed(subject: string | null, prefix: 'Re:' | 'Fwd:'): string {
    const base = (subject ?? '').trim();
    if (!base) return prefix;
    return new RegExp(`^${prefix}\\s`, 'i').test(base) ? base : `${prefix} ${base}`;
}

/**
 * Which of my addresses this message was sent to.
 *
 * A reply should come from the address it was addressed to — replying to a work
 * message from a personal address is a visible mistake, and one the sender
 * notices rather than the author. Falls back to the account default when the
 * original reached none of my identities, which happens with forwards and
 * mailing lists.
 */
async function identityForReply(
    client: ReturnType<typeof getClient>,
    original: Email
): Promise<string | undefined> {
    const identities = await client.getIdentities();
    const mine = new Set(identities.map((i) => i.email.toLowerCase()));
    const addressed = [...addresses(original.to), ...addresses(original.cc)];
    return addressed.find((a) => mine.has(a.toLowerCase()));
}

async function clientFor() {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }
    return { client: getClient(account), manager };
}

export async function draftEmail(params: z.infer<typeof draftEmailSchema>): Promise<DraftResult> {
    const { client, manager } = await clientFor();
    const to = normalizeEmails(params.to);
    if (to.length === 0) throw new Error('At least one recipient is required.');

    const created = await client.createDraft({
        from: params.from,
        to,
        subject: params.subject,
        textBody: params.body,
        cc: normalizeEmails(params.cc).length ? normalizeEmails(params.cc) : undefined,
        bcc: normalizeEmails(params.bcc).length ? normalizeEmails(params.bcc) : undefined,
    });

    return {
        emailId: created.emailId,
        kind: 'new',
        from: created.from,
        to,
        subject: params.subject,
        threaded: false,
        message: 'Draft saved to Drafts. Nothing has been sent.',
        account: manager.getCurrentAccountName(),
    };
}

export async function draftReply(params: z.infer<typeof draftReplySchema>): Promise<DraftResult> {
    const { client, manager } = await clientFor();
    const original = await client.getEmailWithBody(params.emailId);

    let to = normalizeEmails(params.to);
    if (to.length === 0) {
        // Reply-To wins over From: that is what it is for.
        to = addresses(original.replyTo).length ? addresses(original.replyTo) : addresses(original.from);
    }
    if (to.length === 0) {
        throw new Error('The original message has no sender to reply to; pass `to` explicitly.');
    }

    const from = params.from ?? (await identityForReply(client, original));

    let cc = normalizeEmails(params.cc);
    if (params.replyAll) {
        const self = (from ?? '').toLowerCase();
        const others = [...addresses(original.to), ...addresses(original.cc)].filter(
            (a) => a.toLowerCase() !== self && !to.includes(a)
        );
        cc = [...new Set([...cc, ...others])];
    }

    const subject = prefixed(original.subject, 'Re:');
    // messageId is an array and is genuinely null for unsubmitted drafts and
    // some gateway mail. A reply to one of those is unthreaded, not broken --
    // but the caller is told, rather than left to discover it.
    const inReplyTo = original.messageId?.[0];
    const references = [...(original.references ?? []), ...(original.messageId ?? [])];

    const created = await client.createDraft({
        from,
        to,
        subject,
        textBody: params.quote ? `${params.body}${quoted(original)}` : params.body,
        cc: cc.length ? cc : undefined,
        bcc: normalizeEmails(params.bcc).length ? normalizeEmails(params.bcc) : undefined,
        inReplyTo,
        references: references.length ? references : undefined,
    });

    return {
        emailId: created.emailId,
        kind: 'reply',
        from: created.from,
        to,
        subject,
        threaded: Boolean(inReplyTo),
        message:
            'Draft reply saved to Drafts. Nothing has been sent.' +
            (inReplyTo ? '' : ' The original has no Message-ID, so this reply will not thread.'),
        account: manager.getCurrentAccountName(),
    };
}

export async function draftForward(
    params: z.infer<typeof draftForwardSchema>
): Promise<DraftResult> {
    const { client, manager } = await clientFor();
    const original = await client.getEmailWithBody(params.emailId);

    const to = normalizeEmails(params.to);
    if (to.length === 0) throw new Error('At least one recipient is required.');

    const subject = prefixed(original.subject, 'Fwd:');
    const created = await client.createDraft({
        from: params.from ?? (await identityForReply(client, original)),
        to,
        subject,
        textBody: params.quote ? `${params.body}${quoted(original)}` : params.body,
        cc: normalizeEmails(params.cc).length ? normalizeEmails(params.cc) : undefined,
        bcc: normalizeEmails(params.bcc).length ? normalizeEmails(params.bcc) : undefined,
    });

    return {
        emailId: created.emailId,
        kind: 'forward',
        from: created.from,
        to,
        subject,
        // A forward is not a reply; it starts its own conversation.
        threaded: false,
        message: 'Draft forward saved to Drafts. Nothing has been sent.',
        account: manager.getCurrentAccountName(),
    };
}
