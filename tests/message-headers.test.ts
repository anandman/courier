/**
 * RFC 5322 identity headers on the read paths.
 *
 * The JMAP `id` only addresses Fastmail's web app. A caller that wants to open a
 * message in a desktop mail client needs the Message-ID, and one that wants to
 * group a resent thread needs In-Reply-To/References. All three are header
 * properties on the same Email/get that already runs, so exposing them costs no
 * extra request -- the point of these tests is that they are actually requested
 * and actually passed through, including when they are null.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { searchEmails } from '../src/tools/search.js';
import { getEmail } from '../src/tools/read.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [
        {
            name: 'personal@example.com',
            displayName: 'Personal',
            token: 'personal-token',
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        },
    ],
    defaultAccount: 'personal@example.com',
};

const WITH_HEADERS = {
    id: 'Stmtge4GjBeV',
    threadId: 'T1',
    messageId: ['CAJ8xY2@mail.example.com'],
    inReplyTo: ['parent@mail.example.com'],
    references: ['root@mail.example.com', 'parent@mail.example.com'],
    subject: 'Project 4471 — advisor call',
    from: [{ name: 'An Advisor', email: 'advisor@example.com' }],
    to: [{ name: null, email: 'anand@example.com' }],
    receivedAt: '2026-09-01T10:00:00Z',
    sentAt: '2026-09-01T09:59:00Z',
    preview: 'Are you available',
    hasAttachment: false,
    keywords: { $seen: true },
    cc: null,
    replyTo: null,
    bodyValues: {},
    textBody: [],
    htmlBody: [],
    attachments: [],
};

// A draft that was never submitted has no Message-ID at all. Consumers must be
// able to see the absence, so this must survive as null rather than becoming ''.
const WITHOUT_HEADERS = {
    ...WITH_HEADERS,
    id: 'Draft001',
    messageId: null,
    inReplyTo: null,
    references: null,
};

const client = {
    getMailboxByRole: vi.fn(async () => ({ id: 'mbx-inbox', role: 'inbox' })),
    resolveMailbox: vi.fn(async () => ({ id: 'mbx-inbox', role: 'inbox' })),
    queryEmailsPage: vi.fn(async () => ({
        ids: ['Stmtge4GjBeV', 'Draft001'],
        total: 2,
        position: 0,
    })),
    getEmails: vi.fn(async () => [WITH_HEADERS, WITHOUT_HEADERS]),
    getEmailWithBody: vi.fn(async (id: string) =>
        id === 'Draft001' ? WITHOUT_HEADERS : WITH_HEADERS
    ),
    markEmailsRead: vi.fn(async () => undefined),
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

describe('search_emails exposes identity headers', () => {
    beforeEach(() => {
        client.getEmails.mockResolvedValue([WITH_HEADERS, WITHOUT_HEADERS]);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('returns the Message-ID for a whole result set without a body fetch', async () => {
        const result = await run(() => searchEmails({ limit: 10 } as never));

        expect(result.emails[0].messageId).toEqual(['CAJ8xY2@mail.example.com']);
        expect(client.getEmailWithBody).not.toHaveBeenCalled();
    });

    it('returns In-Reply-To and References for thread grouping', async () => {
        const result = await run(() => searchEmails({ limit: 10 } as never));

        expect(result.emails[0].inReplyTo).toEqual(['parent@mail.example.com']);
        expect(result.emails[0].references).toHaveLength(2);
    });

    it('preserves null rather than coercing it to an empty value', async () => {
        // A caller that cannot distinguish "no Message-ID" from "" would build a
        // broken message:// link instead of falling back to the web URL.
        const result = await run(() => searchEmails({ limit: 10 } as never));

        expect(result.emails[1].messageId).toBeNull();
        expect(result.emails[1].inReplyTo).toBeNull();
    });

    it('keeps the JMAP id alongside, since the web URL still needs it', async () => {
        const result = await run(() => searchEmails({ limit: 10 } as never));

        expect(result.emails[0].id).toBe('Stmtge4GjBeV');
        expect(result.emails[0].threadId).toBe('T1');
    });
});

describe('get_email exposes identity headers', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('returns the same raw header shape as search', async () => {
        const email = await run(() => getEmail({ emailId: 'Stmtge4GjBeV', markAsRead: false }));

        expect(email.messageId).toEqual(['CAJ8xY2@mail.example.com']);
        expect(email.inReplyTo).toEqual(['parent@mail.example.com']);
        expect(email.references).toEqual([
            'root@mail.example.com',
            'parent@mail.example.com',
        ]);
    });

    it('reports a missing Message-ID as null', async () => {
        const email = await run(() => getEmail({ emailId: 'Draft001', markAsRead: false }));

        expect(email.messageId).toBeNull();
    });
});
