/**
 * Drafting without sending.
 *
 * Courier could compose-and-send or forward-and-send and had no way to leave a
 * message in Drafts for a human to read first. Sending is not a smaller version
 * of drafting, so none of these tests may ever reach a submission.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import {
    draftEmail,
    draftEmailSchema,
    draftForward,
    draftForwardSchema,
    draftReply,
    draftReplySchema,
} from '../src/tools/draft.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [
        {
            name: 'anand@example.com',
            displayName: 'Personal',
            token: 't',
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        },
    ],
    defaultAccount: 'anand@example.com',
};

const ORIGINAL = {
    id: 'E1',
    threadId: 'T1',
    messageId: ['orig@example.com'],
    inReplyTo: null,
    references: ['root@example.com'],
    subject: 'OAuth client registration request',
    from: [{ name: 'Neil', email: 'neil@provider.example' }],
    to: [{ name: null, email: 'anand@example.com' }],
    cc: [{ name: null, email: 'team@provider.example' }],
    replyTo: null,
    receivedAt: '2026-07-29T20:02:00Z',
    sentAt: '2026-07-29T20:02:00Z',
    preview: '',
    bodyValues: { b: { value: 'We will not accept dynamic registrations.' } },
    textBody: [{ partId: 'b' }],
    keywords: {},
};

let created: Record<string, unknown> | undefined;

const client = {
    getEmailWithBody: vi.fn(async () => ORIGINAL),
    getIdentities: vi.fn(async () => [
        { id: 'i1', email: 'anand@example.com', name: 'Anand' },
        { id: 'i2', email: 'work@example.com', name: 'Anand (work)' },
    ]),
    createDraft: vi.fn(async (p: Record<string, unknown>) => {
        created = p;
        const from = (p.from as string) ?? 'anand@example.com';
        // Mirrors the client: a catch-all domain authorises anything on it.
        const sendable =
            from.endsWith('@example.com') || from.toLowerCase() === 'work@example.com';
        return { emailId: 'DRAFT1', mailboxId: 'mbx-drafts', from, sendable };
    }),
    // Present so a stray call would be visible rather than silently absent.
    sendEmail: vi.fn(async () => {
        throw new Error('drafting must never send');
    }),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

function run<T>(fn: () => Promise<T>): Promise<T> {
    const accountManager = new AccountManager({
        initialConfig: config,
        allowEnv: false,
        allowConfigFile: false,
    });
    return runWithRequestContext({ accountManager }, fn);
}

const newDraft = (p: Record<string, unknown>) =>
    run(() => draftEmail(draftEmailSchema.parse(p)));
const reply = (p: Record<string, unknown>) =>
    run(() => draftReply(draftReplySchema.parse(p)));
const forward = (p: Record<string, unknown>) =>
    run(() => draftForward(draftForwardSchema.parse(p)));

beforeEach(() => {
    created = undefined;
});
afterEach(() => vi.clearAllMocks());

describe('it drafts and never sends', () => {
    it('creates a draft for a new message', async () => {
        const r = await newDraft({ to: 'neil@provider.example', subject: 'Hello', body: 'Hi' });

        expect(r.emailId).toBe('DRAFT1');
        expect(client.createDraft).toHaveBeenCalled();
        expect(client.sendEmail).not.toHaveBeenCalled();
    });

    it('says plainly that nothing was sent', async () => {
        const r = await newDraft({ to: 'a@b.c', subject: 'S', body: 'B' });

        expect(r.message).toMatch(/nothing has been sent/i);
    });
});

describe('reply mode', () => {
    it('threads: carries In-Reply-To and References from the original', async () => {
        // The reason the RFC 5322 headers were exposed in the first place.
        const r = await reply({ emailId: 'E1', body: 'Thanks' });

        expect(created?.inReplyTo).toBe('orig@example.com');
        expect(created?.references).toEqual(['root@example.com', 'orig@example.com']);
        expect(r.threaded).toBe(true);
    });

    it('addresses the original sender without being told', async () => {
        const r = await reply({ emailId: 'E1', body: 'Thanks' });

        expect(r.to).toEqual(['neil@provider.example']);
    });

    it('prefixes the subject once, not twice', async () => {
        client.getEmailWithBody.mockResolvedValueOnce({ ...ORIGINAL, subject: 'Re: Already a reply' });

        const r = await reply({ emailId: 'E1', body: 'x' });

        expect(r.subject).toBe('Re: Already a reply');
    });

    it('adds Re: when there is none', async () => {
        expect((await reply({ emailId: 'E1', body: 'x' })).subject).toBe(
            'Re: OAuth client registration request'
        );
    });

    it('replyAll adds the other recipients but not me', async () => {
        await reply({ emailId: 'E1', body: 'x', replyAll: true });

        expect(created?.cc).toEqual(['team@provider.example']);
    });

    it('quotes the original by default, and can be told not to', async () => {
        await reply({ emailId: 'E1', body: 'Thanks' });
        expect(String(created?.textBody)).toContain('> We will not accept dynamic registrations.');

        await reply({ emailId: 'E1', body: 'Thanks', quote: false });
        expect(String(created?.textBody)).toBe('Thanks');
    });

    it('says so when the original has no Message-ID, instead of silently not threading', async () => {
        // Genuinely happens: unsubmitted drafts and some gateway mail have none.
        client.getEmailWithBody.mockResolvedValueOnce({ ...ORIGINAL, messageId: null });

        const r = await reply({ emailId: 'E1', body: 'x' });

        expect(r.threaded).toBe(false);
        expect(r.message).toMatch(/will not thread/i);
    });

    it('prefers Reply-To over From, which is what it is for', async () => {
        client.getEmailWithBody.mockResolvedValueOnce({
            ...ORIGINAL,
            replyTo: [{ name: null, email: 'list@provider.example' }],
        });

        expect((await reply({ emailId: 'E1', body: 'x' })).to).toEqual([
            'list@provider.example',
        ]);
    });
});

describe('forward mode', () => {
    it('prefixes Fwd: and does not pretend to be a reply', async () => {
        const r = await forward({ emailId: 'E1', to: 'c@d.e', body: 'see below' });

        expect(r.subject).toBe('Fwd: OAuth client registration request');
        expect(created?.inReplyTo).toBeUndefined();
        expect(r.threaded).toBe(false);
    });
});

describe('it refuses rather than guessing', () => {
    it('cannot be asked for a reply without a message to reply to', () => {
        // The point of splitting the tools: this is now a schema error, not a
        // runtime one, so an invalid call cannot be constructed at all.
        expect(() => draftReplySchema.parse({ body: 'x' })).toThrow();
    });

    it('cannot be asked for a new draft without a subject', () => {
        expect(() => draftEmailSchema.parse({ to: 'a@b.c', body: 'B' })).toThrow();
    });

    it('requires a recipient when there is none to infer', () => {
        expect(() => draftEmailSchema.parse({ subject: 'S', body: 'B' })).toThrow();
    });

    it('explains when a reply has no sender to infer', async () => {
        client.getEmailWithBody.mockResolvedValueOnce({ ...ORIGINAL, from: null, replyTo: null });

        await expect(reply({ emailId: 'E1', body: 'x' })).rejects.toThrow(
            /no sender to reply to/i
        );
    });
});

describe('a reply comes from the address it was sent to', () => {
    it('picks the identity the original was addressed to', async () => {
        // Replying to a work message from a personal address is a visible
        // mistake, and one the recipient notices rather than the author.
        client.getEmailWithBody.mockResolvedValueOnce({
            ...ORIGINAL,
            to: [{ name: null, email: 'work@example.com' }],
        });

        const r = await reply({ emailId: 'E1', body: 'x' });

        expect(created?.from).toBe('work@example.com');
        expect(r.from).toBe('work@example.com');
    });

    it('finds the identity on Cc as well as To', async () => {
        client.getEmailWithBody.mockResolvedValueOnce({
            ...ORIGINAL,
            to: [{ name: null, email: 'someone@elsewhere.example' }],
            cc: [{ name: null, email: 'work@example.com' }],
        });

        await reply({ emailId: 'E1', body: 'x' });

        expect(created?.from).toBe('work@example.com');
    });

    it('falls back to the default when none of my addresses were on it', async () => {
        // Happens with forwards and mailing lists.
        client.getEmailWithBody.mockResolvedValueOnce({
            ...ORIGINAL,
            to: [{ name: null, email: 'list@elsewhere.example' }],
            cc: null,
        });

        await reply({ emailId: 'E1', body: 'x' });

        expect(created?.from).toBeUndefined();
    });

    it('an explicit from wins over the inferred one', async () => {
        await reply({ emailId: 'E1', body: 'x', from: 'work@example.com' });

        expect(created?.from).toBe('work@example.com');
    });
});

describe('an unusual From is allowed, and its sendability reported', () => {
    it('accepts an address no identity authorises', async () => {
        // Fastmail stores any From on a draft -- verified against the live
        // account -- so refusing here would be a limiter this client invented,
        // and would block the per-correspondent addresses a catch-all exists for.
        const r = await newDraft({
            to: 'a@b.c',
            subject: 'S',
            body: 'B',
            from: 'anand.storename@sunkcost.farm',
        });

        expect(r.emailId).toBe('DRAFT1');
        expect(r.sendable).toBe(false);
    });

    it('says the draft could not be sent as-is, rather than failing silently', async () => {
        const r = await newDraft({
            to: 'a@b.c',
            subject: 'S',
            body: 'B',
            from: 'anand.storename@sunkcost.farm',
        });

        expect(r.message).toMatch(/would be refused/i);
        expect(r.message).toContain('anand.storename@sunkcost.farm');
    });

    it('stays quiet when the address is authorised', async () => {
        const r = await newDraft({ to: 'a@b.c', subject: 'S', body: 'B' });

        expect(r.sendable).toBe(true);
        expect(r.message).not.toMatch(/refused/i);
    });
});
