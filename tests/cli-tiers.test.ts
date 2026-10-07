import { describe, expect, it } from 'vitest';

import { READ_ONLY_TOOLS, confirmationReason, requiresConfirmation } from '../src/cli/tiers.js';
import { tools } from '../src/tools/index.js';

const serverToolNames = new Set(tools.map((tool) => tool.name));

/**
 * The CLI asks before anything that changes or sends. These tests exist because
 * the list is maintained by hand and the cost of an error is asymmetric: a read
 * wrongly gated costs a flag, a write wrongly ungated sends mail nobody
 * approved.
 */
describe('the read-only list', () => {
    it('names only tools this server actually has', () => {
        // A tool renamed on the server would otherwise leave a dead entry here,
        // and the renamed tool would quietly start requiring --yes with no
        // explanation -- or worse, a future write tool could inherit the name.
        const unknown = [...READ_ONLY_TOOLS].filter((name) => !serverToolNames.has(name));
        expect(unknown).toEqual([]);
    });

    it('contains nothing that writes, sends or deletes', () => {
        const writePrefixes = ['send_', 'forward_', 'draft_', 'delete_', 'create_', 'update_', 'move_', 'mark_', 'tag_', 'rename_', 'set_', 'complete_'];
        const suspicious = [...READ_ONLY_TOOLS].filter((name) =>
            writePrefixes.some((prefix) => name.startsWith(prefix))
        );

        expect(suspicious).toEqual([]);
    });
});

describe('what needs confirmation', () => {
    it('gates every tool that sends mail', () => {
        for (const name of ['send_email', 'forward_email']) {
            expect(requiresConfirmation(name), name).toBe(true);
        }
    });

    it('gates every tool that writes to the mailbox', () => {
        for (const name of ['draft_email', 'draft_reply', 'draft_forward', 'delete_emails', 'move_emails', 'mark_emails', 'tag_emails']) {
            expect(requiresConfirmation(name), name).toBe(true);
        }
    });

    it('gates calendar and contact changes', () => {
        for (const name of ['create_event', 'update_event', 'delete_event', 'create_contact', 'update_contact', 'delete_contact', 'create_task', 'update_task', 'complete_task', 'delete_task']) {
            expect(requiresConfirmation(name), name).toBe(true);
        }
    });

    it('lets reads through', () => {
        for (const name of ['search_emails', 'get_email', 'read_thread', 'changes_since', 'list_mailboxes', 'list_events', 'get_attachment']) {
            expect(requiresConfirmation(name), name).toBe(false);
        }
    });

    /**
     * The list enumerates reads, so a tool added to the server tomorrow is
     * unknown here and gets gated. That direction is the whole design: the
     * inverse list would let a new write tool through by default.
     */
    it('gates a tool it has never heard of', () => {
        expect(requiresConfirmation('some_future_tool')).toBe(true);
        expect(requiresConfirmation('')).toBe(true);
    });

    it('accounts for every tool the server offers', () => {
        // Not an assertion about the split -- just that nothing falls outside
        // it, so no tool can be both ungated and unexamined.
        for (const name of serverToolNames) {
            expect(requiresConfirmation(name)).toBe(!READ_ONLY_TOOLS.has(name));
        }
    });
});

describe('why a tool is gated', () => {
    it('says sending cannot be undone', () => {
        expect(confirmationReason('send_email')).toMatch(/cannot be undone/);
        expect(confirmationReason('forward_email')).toMatch(/cannot be undone/);
    });

    it('distinguishes a draft from a send', () => {
        // Drafting is not outward-facing, and saying it is would train the user
        // to click through the prompt that does matter.
        expect(confirmationReason('draft_reply')).not.toMatch(/cannot be undone/);
        expect(confirmationReason('draft_reply')).toMatch(/mailbox/);
    });

    it('gives every gated tool a reason', () => {
        for (const name of serverToolNames) {
            if (!requiresConfirmation(name)) continue;
            expect(confirmationReason(name), name).not.toBe('');
        }
    });
});
