import { describe, expect, it } from 'vitest';

import { toEmailSummary } from '../src/tools/search.js';
import { tools } from '../src/tools/index.js';

function message(overrides: Record<string, unknown> = {}) {
    return {
        id: 'e1',
        threadId: 't1',
        messageId: ['<a@example.com>'],
        inReplyTo: null,
        references: null,
        subject: 'Weekly digest',
        from: [{ email: 'news@example.com', name: 'News' }],
        to: [],
        receivedAt: '2026-10-08T12:00:00Z',
        preview: '...',
        hasAttachment: false,
        keywords: {},
        ...overrides,
    } as never;
}

/**
 * Whether a message can be unsubscribed from is the most useful fact about a
 * newsletter during triage. Without it an agent can only propose deleting one,
 * which does not stop more arriving -- so it proposes the same deletion again
 * next week, forever.
 */
describe('surfacing the unsubscribe option', () => {
    it('reports the URLs when a message carries them', () => {
        const summary = toEmailSummary(
            message({ 'header:List-Unsubscribe:asURLs': ['https://example.com/u/1', 'mailto:u@example.com'] })
        );

        expect(summary.unsubscribe).toEqual(['https://example.com/u/1', 'mailto:u@example.com']);
    });

    /**
     * Null rather than absent, so a caller can tell "this is not bulk mail"
     * from "this server does not report it".
     */
    it('reports null for ordinary mail', () => {
        expect(toEmailSummary(message()).unsubscribe).toBeNull();
        expect(toEmailSummary(message({ 'header:List-Unsubscribe:asURLs': null })).unsubscribe).toBeNull();
    });
});

describe('what Courier will not do with it', () => {
    /**
     * Unsubscribing is irreversible, silently changes what arrives for months,
     * and is a decision for the person whose mailbox it is. Both consumers
     * reviewing the tool surface said the same thing independently: expose the
     * option, do not let an agent take it.
     */
    it('offers no tool that unsubscribes', () => {
        const names = tools.map((tool) => tool.name);

        expect(names.filter((name) => /unsubscribe/i.test(name))).toEqual([]);
    });
});
