import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { getEmails, getEmailsSchema } from '../src/tools/read.js';
import { defaultTierFor } from '../src/policy/tiers.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'me@example.com',
};

const longBody = 'x'.repeat(10_000);

function message(id: string) {
    return {
        id,
        threadId: `t-${id}`,
        messageId: [`<${id}@example.com>`],
        inReplyTo: null,
        references: null,
        subject: `Subject ${id}`,
        from: [{ email: 'them@example.com', name: 'Them' }],
        to: [{ email: 'me@example.com', name: null }],
        cc: null,
        receivedAt: '2026-10-08T12:00:00Z',
        preview: 'preview text',
        hasAttachment: false,
        attachments: [],
        keywords: { $seen: true },
        textBody: [{ partId: 'p1' }],
        htmlBody: [{ partId: 'p2' }],
        bodyValues: { p1: { value: longBody }, p2: { value: '<p>html</p>' } },
    };
}

let client: {
    getEmails: ReturnType<typeof vi.fn>;
    getEmailsWithBodies: ReturnType<typeof vi.fn>;
    markEmailsRead: ReturnType<typeof vi.fn>;
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

beforeEach(() => {
    client = {
        getEmails: vi.fn(async (ids: string[]) => ids.map(message)),
        getEmailsWithBodies: vi.fn(async (ids: string[]) => ids.map(message)),
        markEmailsRead: vi.fn(),
    };
});

const run = (params: unknown) => {
    const accountManager = new AccountManager({ initialConfig: config, allowEnv: false, allowConfigFile: false });
    return runWithRequestContext({ accountManager }, () => getEmails(getEmailsSchema.parse(params)));
};

describe('reading a shortlist in one call', () => {
    /**
     * A consumer measured 0.38s and 18 KB per message against get_email, and
     * parsed about 400 bytes of each. A 79-message backfill took 30s -- longer
     * than its entire eleven-query search of ten thousand messages.
     */
    it('fetches the whole batch in a single request', async () => {
        const result = await run({ emailIds: ['a', 'b', 'c'] });

        expect(client.getEmailsWithBodies).toHaveBeenCalledOnce();
        expect(client.getEmailsWithBodies).toHaveBeenCalledWith(['a', 'b', 'c']);
        expect(result.returned).toBe(3);
    });

    it('skips body fetching entirely when only headers are wanted', async () => {
        await run({ emailIds: ['a'], includeBodies: false });

        expect(client.getEmailsWithBodies).not.toHaveBeenCalled();
        expect(client.getEmails).toHaveBeenCalledWith(['a']);
    });

    it('treats a zero body budget as headers only', async () => {
        const result = await run({ emailIds: ['a'], maxBodyChars: 0 });

        expect(client.getEmailsWithBodies).not.toHaveBeenCalled();
        expect(result.emails[0].body).toBeUndefined();
    });
});

describe('taking only as much body as asked for', () => {
    it('cuts a long body to the budget', async () => {
        const result = await run({ emailIds: ['a'], maxBodyChars: 100 });

        expect(result.emails[0].body).toHaveLength(100);
        expect(result.emails[0].bodyTruncated).toBe(true);
        expect(result.emails[0].bodyChars).toBe(10_000);
    });

    /**
     * Stated on every message with a body, not only the cut ones, so a caller
     * can tell a short message from one cut to the same length.
     */
    it('says a short body was not cut', async () => {
        client.getEmailsWithBodies.mockResolvedValue([
            { ...message('a'), bodyValues: { p1: { value: 'short' }, p2: { value: '' } } },
        ]);

        const result = await run({ emailIds: ['a'] });

        expect(result.emails[0].bodyTruncated).toBe(false);
        expect(result.emails[0].bodyChars).toBe(5);
    });

    it('leaves HTML out unless asked', async () => {
        expect((await run({ emailIds: ['a'] })).emails[0].htmlBody).toBeUndefined();
        expect((await run({ emailIds: ['a'], includeHtml: true })).emails[0].htmlBody).toBe('<p>html</p>');
    });
});

describe('what came back versus what was asked for', () => {
    /**
     * A caller that asked for twenty and received eighteen has no way to tell
     * which two are missing from a list that looks complete.
     */
    it('names ids that were not found', async () => {
        client.getEmailsWithBodies.mockResolvedValue([message('a'), message('c')]);

        const result = await run({ emailIds: ['a', 'b', 'c'] });

        expect(result.requested).toBe(3);
        expect(result.returned).toBe(2);
        expect(result.missing).toEqual(['b']);
    });

    it('reports nothing missing when everything arrived', async () => {
        expect((await run({ emailIds: ['a', 'b'] })).missing).toEqual([]);
    });
});

describe('limits and safety', () => {
    it('refuses an unbounded batch', async () => {
        const tooMany = Array.from({ length: 51 }, (_, index) => `id-${index}`);
        expect(() => getEmailsSchema.parse({ emailIds: tooMany })).toThrow();
    });

    it('refuses an empty batch rather than answering nothing', () => {
        expect(() => getEmailsSchema.parse({ emailIds: [] })).toThrow();
    });

    /**
     * A batch read is a survey by definition. One that consumed unread state
     * across twenty messages would be the get_email bug twenty times over.
     */
    it('never marks anything read', async () => {
        await run({ emailIds: ['a', 'b'] });

        expect(client.markEmailsRead).not.toHaveBeenCalled();
        expect(Object.keys(getEmailsSchema.shape)).not.toContain('markAsRead');
    });

    it('runs freely, being a read', () => {
        expect(defaultTierFor('get_emails')).toBe('allow');
    });
});
