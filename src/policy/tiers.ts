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
 * Tools that put a message in front of another person.
 *
 * `deny` by default, which is the one place the default is stricter than
 * "ask". Anand's instruction was explicit: an agent should not be able to send
 * mail on his behalf yet. Confirmation is not enough here, because a
 * confirmation prompt is something a person clicks through at the end of a long
 * agent turn, and the action is not reversible afterwards. Promoting a client
 * to `allow` or `confirm` for these is a deliberate per-client decision.
 */
export const OUTWARD_FACING_TOOLS: ReadonlySet<string> = new Set([
    'send_email',
    'forward_email',
]);

/** The tier a tool gets when a client has expressed no preference. */
export function defaultTierFor(toolName: string): Tier {
    if (OUTWARD_FACING_TOOLS.has(toolName)) return 'deny';
    if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
    return 'confirm';
}

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
