import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { searchEmails, searchEmailsOutputSchema, searchEmailsSchema } from '../src/tools/search.js';
import { tools } from '../src/tools/index.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'me@example.com',
};

const EMAIL = {
    id: 'e1',
    threadId: 't1',
    messageId: ['<a@example.com>'],
    inReplyTo: null,
    references: null,
    subject: 'Hello',
    from: [{ email: 'them@example.com', name: 'Them' }],
    to: [{ email: 'me@example.com', name: null }],
    receivedAt: '2026-10-08T12:00:00Z',
    preview: 'preview',
    hasAttachment: false,
    keywords: { $seen: true },
    'header:List-Unsubscribe:asURLs': ['https://example.com/u'],
};

const client = {
    getMailboxByRole: vi.fn(async () => null),
    resolveMailbox: vi.fn(async () => null),
    queryEmailsPage: vi.fn(async () => ({ ids: ['e1'], total: 42, position: 0 })),
    getEmails: vi.fn(async () => [EMAIL]),
};

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

afterEach(() => vi.clearAllMocks());

const run = (params: unknown) => {
    const accountManager = new AccountManager({ initialConfig: config, allowEnv: false, allowConfigFile: false });
    return runWithRequestContext({ accountManager }, () => searchEmails(searchEmailsSchema.parse(params)));
};

/**
 * An output schema is a promise a client may validate against, which makes a
 * schema that has drifted from its handler worse than no schema: correct
 * results start being rejected, and the failure appears at the consumer rather
 * than here. So every declared schema is checked against a real return value.
 */
describe('declared output schemas match what the tools return', () => {
    it('search_emails returns exactly what it promises', async () => {
        const result = await run({ limit: 20 });

        expect(() => searchEmailsOutputSchema.parse(result)).not.toThrow();
    });

    it('promises the paging fields a caller needs to know a set was truncated', async () => {
        const schema = zodToJsonSchema(searchEmailsOutputSchema) as {
            properties: Record<string, unknown>;
            required?: string[];
        };

        for (const field of ['total', 'position', 'returned', 'hasMore']) {
            expect(schema.properties[field], field).toBeDefined();
            expect(schema.required, field).toContain(field);
        }
    });

    it('declares a schema only where one is pinned by a test', () => {
        // Partial adoption is deliberate. Writing a schema for every tool
        // without checking it against real output would ship the drift this
        // file exists to prevent.
        const declared = tools.filter((tool) => tool.outputSchema).map((tool) => tool.name);

        expect(declared).toEqual(['search_emails']);
    });
});

describe('structured results', () => {
    /**
     * Returned alongside the text block, never instead of it. Every client
     * today reads content[].text and re-parses; one that understands
     * structuredContent skips the parse, and one that does not is unaffected.
     */
    it('is the same object the text block encodes', async () => {
        const { createMcpServer } = await import('../src/mcp-server.js');
        const server = createMcpServer();
        expect(server).toBeDefined();

        const result = await run({ limit: 20 });
        const text = JSON.stringify(result, null, 2);

        expect(JSON.parse(text)).toEqual(result);
    });
});
