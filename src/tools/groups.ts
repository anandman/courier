/**
 * Feature groups, for arranging tools in the settings UI.
 *
 * This used to be an enforcement mechanism: a per-user preference that hid
 * whole areas from every client at once. That was removed because the
 * granularity was wrong in both directions. Stopping one client from sending
 * mail meant turning off Email, which also took away search and reading; and
 * the setting applied to every client, so there was no way to let one tool
 * through for a CLI while withholding it from a chat assistant.
 *
 * Permissions are per client now, per tool, and live in the OAuth client
 * registry. What survives here is the grouping itself, which is still the only
 * way to present forty-odd tools to a person without a wall of checkboxes --
 * and it gives the UI something to offer bulk actions over. Nothing in this
 * file decides whether a tool may run.
 */

export const TOOL_GROUP_IDS = ['email', 'contacts', 'calendar', 'tasks'] as const;

export type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

export interface ToolGroup {
    id: ToolGroupId;
    label: string;
    /** Shown in the UI so the choice is understandable without reading tool names. */
    description: string;
    tools: string[];
}

/**
 * Account tools are infrastructure rather than a feature area: they are how a
 * client discovers and targets accounts, which is the reason Courier exists.
 * They belong to no group and are listed on their own.
 */
export const ALWAYS_AVAILABLE_TOOLS = ['list_accounts', 'switch_account', 'get_current_account'];

export const TOOL_GROUPS: ToolGroup[] = [
    {
        id: 'email',
        label: 'Email',
        description: 'Reading, searching, sending and organising mail, plus folder management.',
        tools: [
            'list_mailboxes',
            'create_mailbox',
            'rename_mailbox',
            'delete_mailbox',
            'move_mailbox',
            'get_mailbox_details',
            'set_mailbox_role',
            'search_emails',
            'changes_since',
            'get_email',
            'read_thread',
            'get_attachment',
            'draft_email',
            'draft_reply',
            'draft_forward',
            'update_draft',
            'send_draft',
            'send_email',
            'forward_email',
            'move_emails',
            'delete_emails',
            'mark_emails',
            'tag_emails',
        ],
    },
    {
        id: 'contacts',
        label: 'Contacts',
        description: 'Address books and contact records.',
        tools: [
            'list_address_books',
            'search_contacts',
            'get_contact',
            'create_contact',
            'update_contact',
            'delete_contact',
        ],
    },
    {
        id: 'calendar',
        label: 'Calendar',
        description: 'Calendars and events, over CalDAV.',
        tools: ['list_calendars', 'list_events', 'get_event', 'create_event', 'update_event', 'delete_event'],
    },
    {
        id: 'tasks',
        label: 'Tasks',
        description: 'Task lists from your calendar server.',
        tools: ['list_tasks', 'get_task', 'create_task', 'update_task', 'complete_task', 'delete_task'],
    },
];

const GROUP_BY_TOOL = new Map<string, ToolGroupId>(
    TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.id] as const))
);

/** The group a tool belongs to, or null when it belongs to none. */
export function groupForTool(toolName: string): ToolGroupId | null {
    return GROUP_BY_TOOL.get(toolName) ?? null;
}
