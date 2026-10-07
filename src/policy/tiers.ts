/**
 * What a client may do with each tool.
 *
 * Three tiers, and the names say what happens:
 *
 *   allow    runs
 *   confirm  runs only after a human says yes, through MCP elicitation
 *   deny     never runs
 *
 * This is the only place tools are classified. The CLI's own gate reads the
 * same table, so the two layers cannot disagree about which tools are reads --
 * a disagreement that would show up as a command refusing locally what the
 * server permits, or worse, the reverse.
 *
 * The default is per-tool and deliberately conservative where it matters: a
 * tool nobody has classified is `confirm`, not `allow`. The list enumerates
 * what is safe, so a tool added tomorrow is gated until someone looks at it.
 * The inverse -- enumerate the dangerous ones -- fails by letting a new write
 * tool straight through, and the cost of the two mistakes is not symmetric.
 */

export const TIERS = ['allow', 'confirm', 'deny'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
    return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/**
 * Tools that only read. Every one of these is `allow` by default.
 *
 * Checked against the live tool registry by tests, so a tool renamed on the
 * server cannot quietly fall out of this list and start requiring confirmation
 * with no explanation.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
    'list_accounts',
    'get_current_account',
    'switch_account',
    'list_mailboxes',
    'get_mailbox_details',
    'search_emails',
    'changes_since',
    'get_email',
    'read_thread',
    'get_attachment',
    'list_address_books',
    'search_contacts',
    'get_contact',
    'list_calendars',
    'list_events',
    'get_event',
    'list_tasks',
    'get_task',
]);

/**
 * Tools whose effect cannot be taken back.
 *
 * `deny` by default. This is where the line falls now that `confirm` cannot
 * actually reach anyone over the stateless HTTP transport -- with no third
 * option, every tool has to be either allowed or refused, so the question
 * becomes which mistakes a person can undo.
 *
 * Sending is the obvious case: there is no unsend. The rest are deletions that
 * really delete. Note what is NOT here -- `delete_emails` moves messages to
 * Trash rather than destroying them, so an agent that deletes the wrong thing
 * has made a mess, not a loss, and a default of `deny` would cost more than it
 * protects.
 *
 * Granting any of these is a deliberate per-client decision in settings.
 */
export const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
    // Outward-facing: another person receives something.
    'send_email',
    'forward_email',
    // Destructive: nothing to recover from afterwards.
    'delete_mailbox',
    'delete_contact',
    'delete_event',
    'delete_task',
]);

/**
 * @deprecated Kept as a name for the outward-facing subset, which is worth
 * being able to talk about separately from destruction.
 */
export const OUTWARD_FACING_TOOLS: ReadonlySet<string> = new Set(['send_email', 'forward_email']);

/**
 * The tier a tool gets when a client has expressed no preference.
 *
 * Two outcomes, not three, and deliberately so. `confirm` remains a tier a
 * person can choose per client, but nothing defaults to it: over the stateless
 * HTTP transport a confirmation can never be delivered -- a fresh Server is
 * built per request, so the client's capabilities belong to another instance
 * and its reply would arrive at a third -- and a default that always refuses
 * would be a `deny` wearing a friendlier name.
 *
 * So the dividing line is reversibility. A reversible mistake is allowed,
 * because the cost of an agent getting it wrong is a mess someone can clean up.
 * An irreversible one is refused until deliberately granted.
 *
 * Anything unrecognised is `deny`. The list enumerates what is safe, so a tool
 * added tomorrow is refused until someone classifies it -- noisy, visible, and
 * fixed with one setting. The inverse fails by letting a new destructive tool
 * straight through.
 */
export function defaultTierFor(toolName: string): Tier {
    if (IRREVERSIBLE_TOOLS.has(toolName)) return 'deny';
    if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
    if (REVERSIBLE_WRITE_TOOLS.has(toolName)) return 'allow';
    return 'deny';
}

/**
 * Tools that change something a person can put back.
 *
 * Drafts live in Drafts, deleted mail lives in Trash, a flag can be unset, a
 * moved message can be moved again. Allowed by default because the realistic
 * failure is an agent making a mess rather than destroying anything.
 *
 * `create_event` and `update_event` sit here with a caveat worth stating: they
 * record attendees without emailing them unless `notify` is true, so the tool
 * itself holds the outward-facing part behind a deliberate argument. A client
 * allowed to create events can still pass `notify: true`. If that matters for a
 * given client, set those two to deny for it.
 */
export const REVERSIBLE_WRITE_TOOLS: ReadonlySet<string> = new Set([
    // Mail that stays in the mailbox
    'draft_email',
    'draft_reply',
    'draft_forward',
    'delete_emails',
    'move_emails',
    'mark_emails',
    'tag_emails',
    // Folder structure
    'create_mailbox',
    'rename_mailbox',
    'move_mailbox',
    'set_mailbox_role',
    // Contacts
    'create_contact',
    'update_contact',
    // Calendar and tasks
    'create_event',
    'update_event',
    'create_task',
    'update_task',
    'complete_task',
]);

/**
 * The tier in force for one tool and one client.
 *
 * `overrides` holds only what a human has changed, so the defaults can be
 * revised later without rewriting every stored policy -- and so the UI can show
 * which settings are deliberate rather than inherited.
 */
export function tierFor(toolName: string, overrides?: Readonly<Record<string, Tier>>): Tier {
    const override = overrides?.[toolName];
    return isTier(override) ? override : defaultTierFor(toolName);
}

/**
 * Why a tool is gated, phrased for whoever is being asked.
 *
 * Kept distinct per kind of consequence. A single generic sentence would
 * flatten the difference between sending mail to another person and marking
 * something read, and a prompt that says the same thing every time is a prompt
 * people stop reading.
 */
export function consequenceOf(toolName: string): string {
    if (OUTWARD_FACING_TOOLS.has(toolName)) {
        return 'sends a message to other people, which cannot be undone';
    }
    if (toolName === 'delete_emails') {
        // Said precisely, because the honest answer is reassuring and the vague
        // one is not. This moves mail to Trash; it does not destroy it.
        return 'moves messages to Trash, where they can be recovered';
    }
    if (IRREVERSIBLE_TOOLS.has(toolName)) {
        return 'deletes something permanently';
    }
    if (toolName.startsWith('delete_')) {
        return 'deletes data';
    }
    if (toolName.startsWith('draft_')) {
        return 'writes a message into your mailbox';
    }
    if (toolName === 'create_event' || toolName === 'update_event') {
        return 'changes your calendar, and may notify attendees if asked to';
    }
    if (toolName.startsWith('create_') || toolName.startsWith('update_') || toolName.startsWith('complete_')) {
        return 'changes stored data';
    }
    if (
        toolName.startsWith('move_') ||
        toolName.startsWith('mark_') ||
        toolName.startsWith('tag_') ||
        toolName.startsWith('rename_') ||
        toolName.startsWith('set_')
    ) {
        return 'changes your mailbox, and the change is easy to miss afterwards';
    }
    return 'is not a read, so it is treated as a change';
}
