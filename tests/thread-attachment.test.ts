/**
 * Reading a conversation, and opening what is attached to it.
 *
 * Both were N-calls-and-reassemble: following a thread cost one get_email per
 * message plus sorting them yourself, and an attachment could be seen but never
 * opened — an agent could report that an invoice had arrived and not what was
 * in it.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import {
    getAttachment,
    getAttachmentSchema,
    readThread,
    readThreadSchema,
} from '../src/tools/thread.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'a@example.com', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'a@example.com',
};

const msg = (id: string, at: string, body: string) => ({
    id,
    threadId: 'T1',
    messageId: [`${id}@example.com`],
    receivedAt: at,
    subject: 'Re: contract',
    from: [{ name: null, email: 'them@example.com' }],
    to: [{ name: null, email: 'a@example.com' }],
    cc: null,
    keywords: { $seen: true },
    hasAttachment: false,
    attachments: [],
    preview: body,
    bodyValues: { p: { value: body } },
    textBody: [{ partId: 'p' }],
});

const THREAD = [
    msg('E3', '2026-03-03T00:00:00Z', 'third'),
    msg('E1', '2026-03-01T00:00:00Z', 'first'),
    msg('E2', '2026-03-02T00:00:00Z', 'second'),
];

const PDF = Buffer.from('%PDF-1.4 fake');
const client = {
    getThread: vi.fn(async () => [...THREAD].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))),
    getEmailWithBody: vi.fn(async () => ({
        ...msg('E1', '2026-03-01T00:00:00Z', 'x'),
        attachments: [
            { blobId: 'B1', name: 'invoice.pdf', type: 'application/pdf', size: 13 },
            { blobId: 'B2', name: 'notes.txt', type: 'text/plain', size: 5 },
        ],
    })),
    downloadBlob: vi.fn(async (blobId: string, o: { maxBytes?: number } = {}) => {
        const bytes = blobId === 'B2' ? Buffer.from('hello') : PDF;
        const max = o.maxBytes ?? bytes.length;
        return {
            bytes: bytes.subarray(0, max),
            contentType: blobId === 'B2' ? 'text/plain' : 'application/pdf',
            truncated: bytes.length > max,
        };
    }),
};

vi.mock('jmap-courier', async (i) => ({ ...(await i<Record<string, unknown>>()), getClient: () => client }));

function run<T>(fn: () => Promise<T>): Promise<T> {
    const accountManager = new AccountManager({
        initialConfig: config,
        allowEnv: false,
        allowConfigFile: false,
    });
    return runWithRequestContext({ accountManager }, fn);
}
const thread = (p: Record<string, unknown>) => run(() => readThread(readThreadSchema.parse(p)));
const attach = (p: Record<string, unknown>) => run(() => getAttachment(getAttachmentSchema.parse(p)));

afterEach(() => vi.clearAllMocks());

describe('read_thread', () => {
    it('returns the whole conversation in one call, oldest first', async () => {
        const r = await thread({ threadId: 'T1' });

        expect(r.messages.map((m) => m.id)).toEqual(['E1', 'E2', 'E3']);
        expect(client.getEmailWithBody).not.toHaveBeenCalled();
    });

    it('reports the size of the conversation, not of the page', async () => {
        // The distinction this codebase has had to relearn repeatedly.
        const r = await thread({ threadId: 'T1', limit: 2 });

        expect(r.total).toBe(3);
        expect(r.returned).toBe(2);
        expect(r.truncated).toBe(true);
    });

    it('is not truncated when it holds everything', async () => {
        expect((await thread({ threadId: 'T1' })).truncated).toBe(false);
    });

    it('omits bodies when asked, for a cheap outline', async () => {
        const r = await thread({ threadId: 'T1', includeBodies: false });

        expect(r.messages[0]).not.toHaveProperty('body');
        expect(r.messages[0].from).toBeTruthy();
    });

    it('includes bodies by default', async () => {
        expect((await thread({ threadId: 'T1' })).messages[0]).toHaveProperty('body', 'first');
    });
});

describe('get_attachment', () => {
    it('returns text inline', async () => {
        const r = await attach({ emailId: 'E1', blobId: 'B2' });

        expect(r.encoding).toBe('text');
        expect(r.content).toBe('hello');
    });

    it('base64-encodes anything that is not text', async () => {
        const r = await attach({ emailId: 'E1', blobId: 'B1' });

        expect(r.encoding).toBe('base64');
        expect(Buffer.from(r.content, 'base64').toString()).toBe('%PDF-1.4 fake');
    });

    it('refuses to guess when a message has several attachments', async () => {
        // Guessing is how the wrong file gets read and reported as the right one.
        await expect(attach({ emailId: 'E1' })).rejects.toThrow(/pass blobId/i);
    });

    it('names what is available when the blobId is wrong', async () => {
        await expect(attach({ emailId: 'E1', blobId: 'nope' })).rejects.toThrow(/invoice\.pdf/);
    });

    it('says when it truncated, rather than returning a short file silently', async () => {
        const r = await attach({ emailId: 'E1', blobId: 'B1', maxBytes: 4 });

        expect(r.truncated).toBe(true);
        expect(r.bytesReturned).toBe(4);
        expect(r.message).toMatch(/truncated/i);
    });

    it('reports complete when it is', async () => {
        expect((await attach({ emailId: 'E1', blobId: 'B2' })).truncated).toBe(false);
    });

    it('errors clearly on a message with no attachments', async () => {
        client.getEmailWithBody.mockResolvedValueOnce({
            ...msg('E9', '2026-03-01T00:00:00Z', 'x'),
            attachments: [],
        });

        await expect(attach({ emailId: 'E9' })).rejects.toThrow(/no attachments/i);
    });
});
