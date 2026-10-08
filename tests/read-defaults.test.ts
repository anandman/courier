import { describe, expect, it } from 'vitest';

import { getEmailSchema } from '../src/tools/read.js';
import { readThreadSchema } from '../src/tools/thread.js';

describe('reading does not change what the human sees', () => {
    /**
     * get_email used to mark a message read as a side effect. An agent
     * surveying an inbox to triage it therefore consumed the unread state --
     * which is itself the signal a person triages by, and which nothing
     * restores. A tool named "get" should not mutate, and the mutation is still
     * available by asking for it.
     */
    it('does not mark a message read unless asked', () => {
        expect(getEmailSchema.parse({ emailId: 'x' }).markAsRead).toBe(false);
    });

    it('still marks it read on request', () => {
        expect(getEmailSchema.parse({ emailId: 'x', markAsRead: true }).markAsRead).toBe(true);
    });

    it('says in the schema why the default is what it is', () => {
        const description = getEmailSchema.shape.markAsRead.description ?? '';
        expect(description).toMatch(/triage/i);
        expect(description).toMatch(/FALSE/);
    });
});

describe('a truncated thread keeps the part that matters', () => {
    /**
     * Thread/get returns ids in received order, so taking the first N dropped
     * the newest replies. A 50-message thread read with limit 20 showed the
     * oldest 20, hid everything since, and reported a cheerful total.
     */
    it('describes truncation as keeping the most recent messages', () => {
        const description = readThreadSchema.shape.limit.description ?? '';
        expect(description).toMatch(/MOST RECENT/);
        expect(description).toMatch(/oldest-first/);
        expect(description).toMatch(/truncated/);
    });
});
