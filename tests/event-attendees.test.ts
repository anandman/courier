/**
 * Inviting people is an outward-facing act.
 *
 * Creating an event with attendees makes a CalDAV server send iTIP invitations
 * to real people. An agent should not do that as a side effect of putting
 * something on a calendar, so attendees are recorded by default and emailed
 * only on request.
 *
 * `notify: false` is enforceable rather than aspirational: RFC 6638
 * SCHEDULE-AGENT=NONE suppresses the server's messages. Verified against
 * Fastmail on 2026-10-05 with a control — NONE produced no invitation, the
 * default produced one in the invitee's inbox.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { CalDAVClient } from '../src/caldav/client.js';

/** The iCalendar a create would PUT, without touching a server. */
function ical(event: Record<string, unknown>): string {
    const client = new CalDAVClient({
        serverUrl: 'https://caldav.example.com',
        username: 'me@example.com',
        password: 'x',
    });
    return (
        client as unknown as {
            buildVEVENT: (uid: string, e: unknown) => string;
        }
    ).buildVEVENT('uid-1', {
        summary: 'Review',
        start: '2026-10-08T15:00:00Z',
        end: '2026-10-08T16:00:00Z',
        ...event,
    });
}

afterEach(() => vi.restoreAllMocks());

describe('attendees are recorded', () => {
    it('writes an ATTENDEE line per invitee', () => {
        const out = ical({ attendees: ['a@example.com', 'b@example.com'] });

        expect(out).toContain('mailto:a@example.com');
        expect(out).toContain('mailto:b@example.com');
    });

    it('names an organizer, defaulting to the account', () => {
        expect(ical({ attendees: ['a@example.com'] })).toContain('ORGANIZER:mailto:me@example.com');
    });

    it('lets the organizer be overridden', () => {
        expect(ical({ attendees: ['a@example.com'], organizer: 'team@example.com' })).toContain(
            'ORGANIZER:mailto:team@example.com'
        );
    });
});

describe('nobody is emailed unless asked', () => {
    it('suppresses invitations by default', () => {
        // The guarantee. Without SCHEDULE-AGENT=NONE the server emails them.
        const out = ical({ attendees: ['a@example.com'] });

        expect(out).toContain('SCHEDULE-AGENT=NONE');
    });

    it('sends only when notify is explicitly true', () => {
        const out = ical({ attendees: ['a@example.com'], notify: true });

        expect(out).not.toContain('SCHEDULE-AGENT');
    });

    it('applies the suppression to every attendee, not just the first', () => {
        const out = ical({ attendees: ['a@example.com', 'b@example.com', 'c@example.com'] });

        expect(out.match(/SCHEDULE-AGENT=NONE/g)).toHaveLength(3);
    });

    it('writes no ORGANIZER or ATTENDEE at all when there are no attendees', () => {
        // An event with no invitees must not acquire scheduling semantics.
        const out = ical({});

        expect(out).not.toContain('ATTENDEE');
        expect(out).not.toContain('ORGANIZER');
    });
});
