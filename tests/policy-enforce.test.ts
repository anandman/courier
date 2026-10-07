import { describe, expect, it, vi } from 'vitest';

import { describeCall, enforce } from '../src/policy/enforce.js';
import { IRREVERSIBLE_TOOLS, consequenceOf, defaultTierFor, tierFor } from '../src/policy/tiers.js';
import { tools } from '../src/tools/index.js';

const toolNames = new Set(tools.map((tool) => tool.name));

describe('default tiers', () => {
    it('lets reads through', () => {
        for (const name of ['search_emails', 'get_email', 'read_thread', 'changes_since', 'list_mailboxes']) {
            expect(defaultTierFor(name), name).toBe('allow');
        }
    });

    /**
     * The line is reversibility, because `confirm` cannot reach anyone over the
     * stateless transport and a tier that always refuses would be a deny
     * wearing a friendlier name. So: can a person put this back?
     */
    it('denies what cannot be taken back', () => {
        for (const name of ['send_email', 'forward_email', 'delete_mailbox', 'delete_contact', 'delete_event', 'delete_task']) {
            expect(defaultTierFor(name), name).toBe('deny');
        }
    });

    it('allows changes a person can undo', () => {
        for (const name of ['draft_email', 'move_emails', 'mark_emails', 'tag_emails', 'create_event', 'create_contact']) {
            expect(defaultTierFor(name), name).toBe('allow');
        }
    });

    /**
     * delete_emails moves mail to Trash rather than destroying it, so an agent
     * deleting the wrong thing has made a mess rather than a loss. Denying it
     * by default would cost more than it protects -- and the prompt text says
     * "Trash, where they can be recovered" rather than something vaguer,
     * because the precise answer is the reassuring one.
     */
    it('allows deleting mail, which only moves it to Trash', () => {
        expect(defaultTierFor('delete_emails')).toBe('allow');
        expect(consequenceOf('delete_emails')).toMatch(/Trash/);
        expect(consequenceOf('delete_emails')).toMatch(/recovered/);
    });

    it('distinguishes that from a deletion that really deletes', () => {
        expect(consequenceOf('delete_contact')).toMatch(/permanently/);
        expect(consequenceOf('delete_contact')).not.toMatch(/recovered/);
    });

    /**
     * The lists enumerate what is safe, so a tool added tomorrow is refused
     * until someone classifies it. Noisy, visible, and fixed with one setting.
     * The inverse fails by letting a new destructive tool straight through.
     */
    it('denies a tool it has never heard of', () => {
        expect(defaultTierFor('some_future_tool')).toBe('deny');
    });

    it('leaves no tool unclassified', () => {
        // Every tool should be in exactly one list, so none is denied merely
        // because nobody got round to it.
        const unclassified = [...toolNames].filter(
            (name) => defaultTierFor(name) === 'deny' && !IRREVERSIBLE_TOOLS.has(name)
        );
        expect(unclassified).toEqual([]);
    });

    it('covers every tool the server actually offers', () => {
        for (const name of toolNames) {
            expect(['allow', 'confirm', 'deny'], name).toContain(defaultTierFor(name));
        }
    });
});

describe('per-client overrides', () => {
    it('take precedence over the default', () => {
        expect(tierFor('send_email', { send_email: 'allow' })).toBe('allow');
        expect(tierFor('search_emails', { search_emails: 'deny' })).toBe('deny');
    });

    it('fall back to the default for anything not set', () => {
        expect(tierFor('send_email', { search_emails: 'deny' })).toBe('deny');
        expect(tierFor('get_email', { search_emails: 'deny' })).toBe('allow');
    });

    it('ignore a stored value that is not a tier', () => {
        // The file is on disk and hand-editable. A typo must not become a
        // silent permission.
        expect(tierFor('send_email', { send_email: 'yes' } as never)).toBe('deny');
        expect(tierFor('search_emails', { search_emails: '' } as never)).toBe('allow');
    });
});

describe('enforcement', () => {
    const base = { args: { query: 'x' }, canElicit: true };

    it('runs an allowed tool without asking', async () => {
        const elicit = vi.fn();
        const outcome = await enforce({ ...base, toolName: 'search_emails', elicit });

        expect(outcome.allowed).toBe(true);
        expect(elicit).not.toHaveBeenCalled();
    });

    it('refuses a denied tool and says how to change it', async () => {
        const outcome = await enforce({ ...base, toolName: 'send_email' });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/not permitted/);
        expect(outcome.allowed === false && outcome.reason).toMatch(/Courier settings/);
    });

    it('runs a denied tool once a client is granted it', async () => {
        const outcome = await enforce({ ...base, toolName: 'send_email', overrides: { send_email: 'allow' } });
        expect(outcome.allowed).toBe(true);
    });

    it('asks before a confirm tool, and runs it on accept', async () => {
        // Nothing defaults to confirm any more, but a person can still choose
        // it per client -- and it must work if the transport ever gains a
        // session, so it stays tested.
        const elicit = vi.fn().mockResolvedValue({ action: 'accept' });
        const outcome = await enforce({ ...base, toolName: 'draft_email', overrides: { draft_email: 'confirm' }, elicit });

        expect(elicit).toHaveBeenCalledOnce();
        expect(outcome.allowed).toBe(true);
        expect(outcome.allowed === true && outcome.confirmed).toBe(true);
    });

    it('does not run it on decline', async () => {
        const elicit = vi.fn().mockResolvedValue({ action: 'decline' });
        const outcome = await enforce({ ...base, toolName: 'draft_email', overrides: { draft_email: 'confirm' }, elicit });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/declined/);
    });

    it('does not run it on cancel', async () => {
        const elicit = vi.fn().mockResolvedValue({ action: 'cancel' });
        const outcome = await enforce({ ...base, toolName: 'draft_email', overrides: { draft_email: 'confirm' }, elicit });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/not confirmed/);
    });

    /**
     * The load-bearing case. Treating "nobody could be asked" as consent would
     * convert every confirm into an allow for exactly the unattended clients
     * the tier exists to constrain.
     */
    it('refuses a confirm tool when the client cannot ask anyone', async () => {
        const outcome = await enforce({ ...base, toolName: 'delete_emails', overrides: { delete_emails: 'confirm' }, canElicit: false });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/cannot ask you/);
        expect(outcome.allowed === false && outcome.reason).toMatch(/elicitation/);
    });

    it('refuses when the client declared elicitation but has no way to send it', async () => {
        const outcome = await enforce({ ...base, toolName: 'delete_emails', overrides: { delete_emails: 'confirm' }, canElicit: true, elicit: undefined });
        expect(outcome.allowed).toBe(false);
    });

    it('treats a failed prompt as a no, not a yes', async () => {
        const elicit = vi.fn().mockRejectedValue(new Error('request timed out'));
        const outcome = await enforce({ ...base, toolName: 'draft_email', overrides: { draft_email: 'confirm' }, elicit });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/timed out/);
    });

    it('treats an unreadable response as a no', async () => {
        const elicit = vi.fn().mockResolvedValue({ action: 'sure thing' });
        const outcome = await enforce({ ...base, toolName: 'draft_email', overrides: { draft_email: 'confirm' }, elicit });

        expect(outcome.allowed).toBe(false);
        expect(outcome.allowed === false && outcome.reason).toMatch(/could not be understood/);
    });

    it('never asks about a denied tool', async () => {
        // Prompting for something that cannot run either teaches the user their
        // answer does not matter, or implies it might.
        const elicit = vi.fn().mockResolvedValue({ action: 'accept' });
        await enforce({ ...base, toolName: 'send_email', elicit });

        expect(elicit).not.toHaveBeenCalled();
    });
});

describe('what the confirmation prompt says', () => {
    it('names the tool and its consequence', () => {
        const message = describeCall('delete_emails', { emailIds: ['a'] });

        expect(message).toContain('delete_emails');
        expect(message).toContain(consequenceOf('delete_emails'));
    });

    /**
     * Argument KEYS only. A draft body, a recipient list and a search query are
     * all arguments, and this text is rendered by the client and may be logged
     * by it. The server's own tool log follows the same rule.
     */
    it('lists argument names and never their values', () => {
        const message = describeCall('send_email', {
            to: ['someone@example.com'],
            subject: 'Quarterly numbers',
            body: 'Confidential',
        });

        expect(message).toContain('to');
        expect(message).toContain('subject');
        expect(message).not.toContain('someone@example.com');
        expect(message).not.toContain('Quarterly numbers');
        expect(message).not.toContain('Confidential');
    });

    it('copes with no arguments at all', () => {
        expect(describeCall('list_accounts', undefined)).toContain('list_accounts');
        expect(describeCall('list_accounts', {})).toContain('list_accounts');
    });
});
