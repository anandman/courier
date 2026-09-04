/**
 * Courier adapts to the scope of the token it was given.
 *
 * A Fastmail API token can be minted read-only, or mail-only, or without
 * contacts, and the session document reports which. A tool the credential can
 * never satisfy should not be offered and should not be attempted: the call
 * costs a round trip to earn a 403, and "Disallowed capabilities for this
 * type/client" tells the user nothing about what to do next.
 *
 * The live account's tokens turned out to advertise core, mail and submission
 * and no contacts -- so six contact tools were being offered that could not
 * possibly work.
 */

import { describe, expect, it } from 'vitest';
import { JMAP_CAPABILITIES } from 'jmap-courier';

import { capabilityForTool, isToolSupported, unsupportedToolMessage } from '../src/tools/scopes.js';

const READ_ONLY = new Set([JMAP_CAPABILITIES.core, JMAP_CAPABILITIES.mail]);
const MAIL_AND_SEND = new Set([
    JMAP_CAPABILITIES.core,
    JMAP_CAPABILITIES.mail,
    JMAP_CAPABILITIES.submission,
]);
const EVERYTHING = new Set([...MAIL_AND_SEND, JMAP_CAPABILITIES.contacts]);

describe('a read-only token', () => {
    it.each(['search_emails', 'get_email', 'list_mailboxes'])('can still %s', (tool) => {
        expect(isToolSupported(tool, READ_ONLY)).toBe(true);
    });

    it.each(['send_email', 'forward_email'])('cannot %s', (tool) => {
        expect(isToolSupported(tool, READ_ONLY)).toBe(false);
    });

    it('cannot reach contacts either', () => {
        expect(isToolSupported('search_contacts', READ_ONLY)).toBe(false);
    });

    it('keeps mutating mail tools, which are writes but not sends', () => {
        // mark_emails and move_emails are Email/set: a write, but not submission.
        // Whether the token permits them is the provider's call at request time.
        expect(capabilityForTool('mark_emails')).toBe(JMAP_CAPABILITIES.mail);
        expect(capabilityForTool('move_emails')).toBe(JMAP_CAPABILITIES.mail);
    });
});

describe('the tokens this server actually holds', () => {
    it('can send, matching their advertised submission scope', () => {
        expect(isToolSupported('send_email', MAIL_AND_SEND)).toBe(true);
    });

    it.each([
        'search_contacts',
        'get_contact',
        'create_contact',
        'update_contact',
        'delete_contact',
        'list_address_books',
    ])('hides %s, which no current token can satisfy', (tool) => {
        expect(isToolSupported(tool, MAIL_AND_SEND)).toBe(false);
    });

    it('offers contact tools once a contacts-scoped token is used', () => {
        expect(isToolSupported('search_contacts', EVERYTHING)).toBe(true);
    });
});

describe('tools that JMAP scope must not gate', () => {
    it.each([
        'list_calendars',
        'list_events',
        'create_event',
        'list_tasks',
        'complete_task',
    ])('%s runs over CalDAV and stays available on a mail-only token', (tool) => {
        // Gating these on a JMAP capability would hide tools that work fine,
        // since CalDAV carries its own separate credential.
        expect(capabilityForTool(tool)).toBeNull();
        expect(isToolSupported(tool, READ_ONLY)).toBe(true);
    });

    it.each(['list_accounts', 'switch_account', 'get_current_account'])(
        '%s is infrastructure and never gated',
        (tool) => {
            expect(isToolSupported(tool, new Set())).toBe(true);
        }
    );
});

describe('unknown capabilities permit everything', () => {
    it('offers every tool when the session could not be read', () => {
        // A session fetch that times out must not present an empty server.
        for (const tool of ['search_emails', 'send_email', 'search_contacts']) {
            expect(isToolSupported(tool, null)).toBe(true);
        }
    });
});

describe('the error says what is wrong and what to do', () => {
    it('names the missing permission in plain words, not a URN', () => {
        const message = unsupportedToolMessage('send_email');

        expect(message).toContain('send mail');
        expect(message).not.toContain('urn:ietf:params');
    });

    it('names the tool that was refused', () => {
        expect(unsupportedToolMessage('search_contacts')).toContain('search_contacts');
    });

    it('tells the user how to fix it', () => {
        expect(unsupportedToolMessage('search_contacts')).toMatch(/token with that scope/i);
    });
});
