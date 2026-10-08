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
            'Address to send as. A catch-all domain permits any address on it. Any value is accepted for a draft; the result reports sendable: false when no identity authorises it.'
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
    /**
     * False when no identity authorises the From address. The draft still
     * exists and is editable; sending it would be refused by the provider.
     */
    sendable: boolean;
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
        sendable: created.sendable,
        kind: 'new',
        from: created.from,
        to,
        subject: params.subject,
        threaded: false,
        message:
            'Draft saved to Drafts. Nothing has been sent.' +
            (created.sendable ? '' : ` No identity authorises "${created.from}", so sending this draft would be refused.`),
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
        sendable: created.sendable,
        kind: 'reply',
        from: created.from,
        to,
        subject,
        threaded: Boolean(inReplyTo),
        message:
            'Draft reply saved to Drafts. Nothing has been sent.' +
            (inReplyTo ? '' : ' The original has no Message-ID, so this reply will not thread.') +
            (created.sendable ? '' : ` No identity authorises "${created.from}", so sending this draft would be refused.`),
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
        sendable: created.sendable,
        kind: 'forward',
        from: created.from,
        to,
        subject,
        // A forward is not a reply; it starts its own conversation.
        threaded: false,
        message:
            'Draft forward saved to Drafts. Nothing has been sent.' +
            (created.sendable ? '' : ` No identity authorises "${created.from}", so sending this draft would be refused.`),
        account: manager.getCurrentAccountName(),
    };
}

export const updateDraftSchema = z.object({
    emailId: z.string().describe('The draft to revise (use the emailId a draft tool returned)'),
    body: z.string().optional().describe('Replacement body. Omit to keep the current one.'),
    subject: z.string().optional().describe('Replacement subject. Omit to keep the current one.'),
    to: recipients.optional().describe('Replacement recipient(s). Omit to keep the current ones.'),
    ...common,
});

export interface UpdateDraftResult extends DraftResult {
    /**
     * The id this draft had before. It no longer addresses anything editable.
     *
     * Returned because a caller holding the old id would otherwise keep using
     * it and silently operate on a message sitting in Trash -- the same shape
     * as every other quietly-wrong answer this server has produced.
     */
    previousEmailId: string;
    previousVersion: 'trash';
}

/**
 * Revises a draft in place, as far as JMAP allows.
 *
 * It does not allow much: RFC 8621 makes an Email immutable except for
 * `keywords` and `mailboxIds`, so there is no edit operation for a body or a
 * subject anywhere in the protocol. Every mail client that offers one does what
 * this does -- write a new message and retire the old -- including Fastmail's
 * own.
 *
 * Which is exactly why this is a tool rather than a note in the documentation.
 * A client doing it by hand has to reconstruct the parts it did not mean to
 * change, and the part it most reliably gets wrong is threading: In-Reply-To
 * and References are invisible in a Drafts list and wrong in every client that
 * threads, so a "revised" reply quietly becomes a new conversation. Inheriting
 * them here is the whole point. Identity, cc, bcc and reply-to are inherited
 * for the same reason.
 *
 * The old version goes to Trash rather than being destroyed. Destroying is what
 * mail clients do and it leaves no litter, but it cannot tell a draft the agent
 * wrote ten seconds ago from one a person spent ten minutes on -- and this
 * server's rule is that a reversible mistake may run freely while an
 * irreversible one must be granted. Trash keeps that true, and keeps this tool
 * in the same tier as the drafting tools it belongs with.
 */
export async function updateDraft(
    params: z.infer<typeof updateDraftSchema>
): Promise<UpdateDraftResult> {
    const { client, manager } = await clientFor();
    const original = await client.getEmailWithBody(params.emailId);

    // Must be IN Drafts, not merely carry the $draft keyword.
    //
    // Keywords survive a move, so a draft that has already been superseded --
    // sitting in Trash because someone revised it in a mail client, which does
    // the same create-and-retire dance this tool does -- still reads as
    // $draft: true. Accepting that would take the stale copy the caller is
    // holding, rebuild it, and quietly discard whatever the person wrote in
    // between. Requiring current membership of Drafts is what detects the
    // intervening edit: the id a caller holds stops being editable the moment
    // someone else revises it, which is exactly the signal wanted.
    const drafts = await client.getMailboxByRole('drafts');
    if (!drafts) {
        throw new Error('No Drafts mailbox found on this account, so there is nothing to revise.');
    }
    if (original.mailboxIds?.[drafts.id] !== true) {
        const superseded = original.keywords?.$draft === true;
        throw new Error(
            superseded
                ? `${params.emailId} is no longer in Drafts. It was most likely revised or sent elsewhere, which replaces the message and leaves this copy behind -- revising it now would discard that newer version. Find the current draft with search_emails and use its id.`
                : `${params.emailId} is not a draft, and a message that has been sent or received cannot be edited -- JMAP makes it immutable. Use draft_reply or draft_forward to write a new message about it instead.`
        );
    }

    const to = params.to !== undefined ? normalizeEmails(params.to) : addresses(original.to);
    if (to.length === 0) {
        throw new Error('A draft needs at least one recipient; pass `to`.');
    }

    const cc = params.cc !== undefined ? normalizeEmails(params.cc) : addresses(original.cc);
    const bcc = params.bcc !== undefined ? normalizeEmails(params.bcc) : addresses(original.bcc);
    const subject = params.subject ?? original.subject ?? '';
    const body = params.body ?? textOf(original);
    const from = params.from ?? addresses(original.from)[0];

    // Threading is inherited verbatim. These headers are what make a revised
    // reply still a reply, and nothing in the arguments can set them: a caller
    // revising a draft is not changing which conversation it belongs to.
    const inReplyTo = original.inReplyTo?.[0];
    const references = original.references ?? undefined;

    const created = await client.createDraft({
        from,
        to,
        subject,
        textBody: body,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        inReplyTo,
        references: references?.length ? references : undefined,
    });

    // Retired only after the replacement exists. The reverse order risks a
    // window with no draft at all, and a failure here leaves two drafts --
    // untidy, but nothing is lost, which is the right way round.
    await client.deleteEmails([params.emailId]);

    return {
        emailId: created.emailId,
        previousEmailId: params.emailId,
        previousVersion: 'trash',
        sendable: created.sendable,
        kind: inReplyTo ? 'reply' : 'new',
        from: created.from,
        to,
        subject,
        threaded: Boolean(inReplyTo),
        message:
            `Draft revised. Its id is now ${created.emailId}; ${params.emailId} is in Trash and should not be used again. Nothing has been sent.` +
            (created.sendable ? '' : ` No identity authorises "${created.from}", so sending this draft would be refused.`),
        account: manager.getCurrentAccountName(),
    };
}
