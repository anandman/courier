import { describe, expect, it } from 'vitest';

import { describeToolFailure, unwrapPayload } from '../src/cli/connect.js';
import { CliError, EXIT } from '../src/cli/exit.js';

/**
 * This file guards the one failure this project keeps reproducing: a result
 * that means "I could not look" being read as "I looked and found nothing".
 *
 * A peer consumer lost a day of mail ingestion to exactly this -- its client
 * checked neither `isError` nor a body-level error, so a disabled API token
 * arrived as `total: None, emails: []`. The CLI exists partly so no consumer
 * has to get that right again, which makes these the load-bearing tests.
 */
describe('unwrapping a tool result', () => {
    it('returns the parsed JSON of a single text block', () => {
        const payload = unwrapPayload(
            { content: [{ type: 'text', text: '{"total":3,"emails":[1,2,3]}' }] },
            'search_emails'
        );

        expect(payload).toEqual({ total: 3, emails: [1, 2, 3] });
    });

    it('returns text as text when it is not JSON', () => {
        expect(unwrapPayload({ content: [{ type: 'text', text: 'hello' }] }, 'anything')).toBe('hello');
    });

    it('prefers structuredContent when the server sends it', () => {
        const payload = unwrapPayload(
            { structuredContent: { total: 1 }, content: [{ type: 'text', text: '{"total":99}' }] },
            'search_emails'
        );

        expect(payload).toEqual({ total: 1 });
    });

    it('keeps every block when there is more than one', () => {
        const payload = unwrapPayload(
            {
                content: [
                    { type: 'text', text: '{"a":1}' },
                    { type: 'text', text: 'plain' },
                ],
            },
            'anything'
        );

        expect(payload).toEqual([{ a: 1 }, 'plain']);
    });

    it('passes non-text blocks through rather than flattening them', () => {
        const blocks = [{ type: 'image', data: 'abc', mimeType: 'image/png' }];
        expect(unwrapPayload({ content: blocks }, 'get_attachment')).toEqual(blocks);
    });

    /**
     * An empty content array is legal MCP and would unwrap to nothing at all.
     * Printing `{}` or `[]` for it would be the page-size-as-total bug again in
     * a new costume: well-formed, plausible, and smaller than the truth.
     */
    it('refuses to treat a result with no content as an answer', () => {
        expect(() => unwrapPayload({ content: [] }, 'changes_since')).toThrowError(CliError);

        try {
            unwrapPayload({ content: [] }, 'changes_since');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.TOOL_ERROR);
            expect((error as CliError).message).toContain('no content');
        }
    });

    it('refuses a result with no content key at all', () => {
        expect(() => unwrapPayload({}, 'changes_since')).toThrowError(CliError);
    });

    /**
     * The empty answer that IS real must still get through: zero matches is a
     * legitimate result, and the strictness above is only worth having if this
     * case stays trustworthy.
     */
    it('passes a genuinely empty result through untouched', () => {
        const payload = unwrapPayload(
            { content: [{ type: 'text', text: '{"total":0,"returned":0,"emails":[]}' }] },
            'search_emails'
        );

        expect(payload).toEqual({ total: 0, returned: 0, emails: [] });
    });
});

describe('telling a refused provider credential from an ordinary failure', () => {
    /**
     * The one failure neither retrying nor re-authorising fixes: Courier's own
     * JMAP token or DAV app password was rejected, and a human must replace it.
     * Untagged it was indistinguishable from "no such email id", leaving an
     * unattended consumer to retry forever or stop for everything.
     *
     * Carried by a structured errorCode the server sets. Never inferred from
     * the message -- matching on wording is how a classification rots silently
     * while continuing to look authoritative.
     */
    it('reads the code the server set, from structuredContent', () => {
        const failure = describeToolFailure({
            isError: true,
            structuredContent: { error: 'provider rejected the token', errorCode: 'upstream-auth' },
            content: [{ type: 'text', text: '{"error":"provider rejected the token","errorCode":"upstream-auth"}' }],
        });

        expect(failure.code).toBe('upstream-auth');
        expect(failure.message).toBe('provider rejected the token');
    });

    it('reads it from the text block when there is no structured content', () => {
        const failure = describeToolFailure({
            isError: true,
            content: [{ type: 'text', text: '{"error":"refused","errorCode":"upstream-auth"}' }],
        });

        expect(failure.code).toBe('upstream-auth');
    });

    it('leaves an ordinary failure uncoded', () => {
        const failure = describeToolFailure({
            isError: true,
            content: [{ type: 'text', text: '{"error":"Email not found: abc"}' }],
        });

        expect(failure.code).toBeUndefined();
        expect(failure.message).toBe('Email not found: abc');
    });

    it('does not invent a code from wording that merely sounds like one', () => {
        const failure = describeToolFailure({
            isError: true,
            content: [{ type: 'text', text: '{"error":"API token has been disabled"}' }],
        });

        expect(failure.code).toBeUndefined();
    });

    it('still reports a message when the server sent no JSON at all', () => {
        expect(describeToolFailure({ isError: true, content: [{ type: 'text', text: 'plain' }] })).toEqual({
            message: 'plain',
        });
    });
});
