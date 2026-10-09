import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AccountManager } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { updateDraft, updateDraftSchema } from '../src/tools/draft.js';
import { tools } from '../src/tools/index.js';
import { defaultTierFor } from '../src/policy/tiers.js';

vi.mock('jmap-courier', async () => {
    const actual = await vi.importActual<typeof import('jmap-courier')>('jmap-courier');
    return { ...actual, getClient: () => client };
});

const DRAFTS = { id: 'mb-drafts', name: 'Drafts', role: 'drafts' };

let client: {
    getEmailWithBody: ReturnType<typeof vi.fn>;
    getMailboxByRole: ReturnType<typeof vi.fn>;
    createDraft: ReturnType<typeof vi.fn>;
    deleteEmails: ReturnType<typeof vi.fn>;
};

const original = {
    id: 'old-id',
    subject: 'Re: Quarterly numbers',
    from: [{ email: 'me@example.com', name: 'Me' }],
    to: [{ email: 'them@example.com', name: null }],
    cc: [{ email: 'cc@example.com', name: null }],
    bcc: [],
    keywords: { $draft: true },
    mailboxIds: { 'mb-drafts': true },
    inReplyTo: ['<original@example.com>'],
    references: ['<first@example.com>', '<original@example.com>'],
    textBody: [{ partId: 'p1' }],
    bodyValues: { p1: { value: 'first attempt' } },
    preview: 'first attempt',
};

beforeEach(() => {
    client = {
        getEmailWithBody: vi.fn().mockResolvedValue(original),
        getMailboxByRole: vi.fn().mockResolvedValue(DRAFTS),
        createDraft: vi
            .fn()
            .mockResolvedValue({ emailId: 'new-id', mailboxId: 'mb-drafts', from: 'me@example.com', sendable: true }),
        deleteEmails: vi.fn().mockResolvedValue(undefined),
    };
});

const manager = new AccountManager({
    initialConfig: {
        accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
        defaultAccount: 'me@example.com',
    },
    allowEnv: false,
    allowConfigFile: false,
});

const run = (params: unknown) =>
    runWithRequestContext({ accountManager: manager }, () =>
        updateDraft(updateDraftSchema.parse(params))
    );

describe('revising a draft', () => {
    it('replaces only what was named', async () => {
        await run({ emailId: 'old-id', body: 'second attempt' });

        const sent = client.createDraft.mock.calls[0][0];
        expect(sent.textBody).toBe('second attempt');
        expect(sent.subject).toBe('Re: Quarterly numbers');
        expect(sent.to).toEqual(['them@example.com']);
        expect(sent.cc).toEqual(['cc@example.com']);
        expect(sent.from).toBe('me@example.com');
    });

    /**
     * The reason this is a tool and not a note in the docs. In-Reply-To and
     * References are invisible in a Drafts list and wrong in every client that
     * threads, so a client re-creating a draft by hand turns a revised reply
     * into a new conversation and nothing says so.
     */
    it('inherits the threading headers', async () => {
        await run({ emailId: 'old-id', body: 'second attempt' });

        const sent = client.createDraft.mock.calls[0][0];
        expect(sent.inReplyTo).toBe('<original@example.com>');
        expect(sent.references).toEqual(['<first@example.com>', '<original@example.com>']);
    });

    it('reports that it still threads', async () => {
        const result = await run({ emailId: 'old-id', body: 'x' });
        expect(result.threadingHeadersWritten).toBe(true);
        expect(result.kind).toBe('reply');
    });

    it('accepts replacements for subject and recipients', async () => {
        await run({ emailId: 'old-id', subject: 'New subject', to: 'someone@example.com' });

        const sent = client.createDraft.mock.calls[0][0];
        expect(sent.subject).toBe('New subject');
        expect(sent.to).toEqual(['someone@example.com']);
        // Body was not named, so it is kept.
        expect(sent.textBody).toBe('first attempt');
    });

    it('moves the old version to Trash rather than destroying it', async () => {
        const result = await run({ emailId: 'old-id', body: 'x' });

        expect(client.deleteEmails).toHaveBeenCalledWith(['old-id']);
        expect(result.previousVersion).toBe('trash');
    });

    /**
     * Written before the old one is retired. The reverse order risks a window
     * with no draft at all; this way a failure leaves two drafts, which is
     * untidy rather than lossy.
     */
    it('creates the replacement before retiring the original', async () => {
        const order: string[] = [];
        client.createDraft.mockImplementation(async () => {
            order.push('create');
            return { emailId: 'new-id', mailboxId: 'mb-drafts', from: 'me@example.com', sendable: true };
        });
        client.deleteEmails.mockImplementation(async () => {
            order.push('retire');
        });

        await run({ emailId: 'old-id', body: 'x' });
        expect(order).toEqual(['create', 'retire']);
    });

    it('does not retire the original when the replacement fails', async () => {
        client.createDraft.mockRejectedValue(new Error('Email/set failed'));

        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/Email\/set failed/);
        expect(client.deleteEmails).not.toHaveBeenCalled();
    });

    /**
     * A caller holding the old id would otherwise keep using it and silently
     * operate on a message in Trash -- the same shape as every other quietly
     * wrong answer this server has produced.
     */
    it('returns both ids and says the old one is finished with', async () => {
        const result = await run({ emailId: 'old-id', body: 'x' });

        expect(result.emailId).toBe('new-id');
        expect(result.previousEmailId).toBe('old-id');
        expect(result.message).toContain('new-id');
        expect(result.message).toContain('should not be used again');
        expect(result.message).toContain('Nothing has been sent');
    });

    it('reports an unsendable identity rather than refusing', async () => {
        client.createDraft.mockResolvedValue({
            emailId: 'new-id',
            mailboxId: 'mb-drafts',
            from: 'nobody@example.com',
            sendable: false,
        });

        const result = await run({ emailId: 'old-id', body: 'x' });
        expect(result.sendable).toBe(false);
        expect(result.message).toMatch(/would be refused/);
    });
});

describe('refusing what cannot be revised', () => {
    /**
     * JMAP makes a received or sent message immutable. Attempting it would
     * fail somewhere in mailbox handling, with an error about mailboxes --
     * which explains nothing to whoever asked to edit a message.
     */
    it('refuses a message that is not a draft, and says why', async () => {
        client.getEmailWithBody.mockResolvedValue({
            ...original,
            keywords: { $seen: true },
            mailboxIds: { 'mb-inbox': true },
        });

        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/not a draft/);
        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/immutable/);
        expect(client.createDraft).not.toHaveBeenCalled();
        expect(client.deleteEmails).not.toHaveBeenCalled();
    });

    it('accepts a draft that is in Drafts but carries no keyword', async () => {
        client.getEmailWithBody.mockResolvedValue({ ...original, keywords: {} });
        await expect(run({ emailId: 'old-id', body: 'x' })).resolves.toBeDefined();
    });

    /**
     * The safeguard that matters most. Keywords survive a move, so a draft
     * superseded by someone revising it in a mail client -- which does the same
     * create-and-retire dance -- still reads as $draft: true while sitting in
     * Trash. Accepting it would rebuild the stale copy the caller is holding
     * and quietly discard whatever the person wrote in between.
     */
    it('refuses a draft that has been superseded since the caller saw it', async () => {
        client.getEmailWithBody.mockResolvedValue({
            ...original,
            keywords: { $draft: true },
            mailboxIds: { 'mb-trash': true },
        });

        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/no longer in Drafts/);
        expect(client.createDraft).not.toHaveBeenCalled();
        expect(client.deleteEmails).not.toHaveBeenCalled();
    });

    it('tells the caller a newer version exists rather than just refusing', async () => {
        client.getEmailWithBody.mockResolvedValue({
            ...original,
            keywords: { $draft: true },
            mailboxIds: { 'mb-trash': true },
        });

        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/discard that newer version/);
        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/search_emails/);
    });

    it('refuses to leave a draft with no recipient', async () => {
        client.getEmailWithBody.mockResolvedValue({ ...original, to: [] });
        await expect(run({ emailId: 'old-id', body: 'x' })).rejects.toThrow(/at least one recipient/);
    });
});

describe('how update_draft is exposed', () => {
    it('is advertised', () => {
        expect(tools.map((tool) => tool.name)).toContain('update_draft');
    });

    it('warns in its description that the id changes', () => {
        const tool = tools.find((candidate) => candidate.name === 'update_draft');
        expect(tool?.description).toMatch(/ID CHANGES/);
        expect(tool?.description).toMatch(/Trash/);
    });

    it('runs by default, like the other draft tools', () => {
        // It is reversible: the previous version is in Trash, and nothing is
        // transmitted. That is the same test every allowed tool passes.
        expect(defaultTierFor('update_draft')).toBe('allow');
    });
});
