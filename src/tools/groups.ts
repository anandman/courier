/**
 * Feature groups for tool visibility.
 *
 * Which tools a user wants is a per-user question, not a per-deployment one:
 * one person may never touch tasks while another relies on them, and
 * both are served by the same Courier. So this is a stored preference, exposed
 * in the setup UI, rather than server configuration.
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
 * They are never hidden and belong to no group.
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
        description: 'Task lists from your calendar server. Turn this off if you keep tasks somewhere else.',
        tools: ['list_tasks', 'get_task', 'create_task', 'update_task', 'complete_task', 'delete_task'],
    },
];

const GROUP_BY_TOOL = new Map<string, ToolGroupId>(
    TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool, group.id] as const))
);

/** The group a tool belongs to, or null if it is always available. */
export function groupForTool(toolName: string): ToolGroupId | null {
    return GROUP_BY_TOOL.get(toolName) ?? null;
}

/**
 * Normalises stored preferences. Unknown ids are dropped rather than rejected:
 * a group removed in a later version must not make a saved config unloadable.
 */
export function parseDisabledGroups(value: unknown): ToolGroupId[] {
    if (!Array.isArray(value)) return [];
    const known = new Set<string>(TOOL_GROUP_IDS);
    return [...new Set(value.filter((id): id is ToolGroupId => typeof id === 'string' && known.has(id)))];
}

/**
 * Absence means everything is on. Storing the *disabled* set rather than the
 * enabled one is what makes that true without a migration, and means a group
 * added in a later version is on by default rather than silently missing.
 */
export function isToolVisible(toolName: string, disabledGroups: readonly ToolGroupId[]): boolean {
    const group = groupForTool(toolName);
    if (group === null) return true;
    return !disabledGroups.includes(group);
}
