/**
 * Tool registry for MCP server
 * Exports all tools with their schemas and handlers
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';

// Account tools
import {
    listAccountsSchema,
    switchAccountSchema,
    getCurrentAccountSchema,
    listAccounts,
    switchAccount,
    getCurrentAccount,
} from './accounts.js';

// Mailbox tools
import {
    listMailboxesSchema,
    listMailboxes,
    createMailboxSchema,
    createMailbox,
    renameMailboxSchema,
    renameMailbox,
    deleteMailboxSchema,
    deleteMailbox,
    moveMailboxSchema,
    moveMailbox,
    getMailboxDetailsSchema,
    getMailboxDetails,
    setMailboxRoleSchema,
    setMailboxRole,
} from './mailboxes.js';

// Contacts tools
import {
    listAddressBooksSchema,
    listAddressBooks,
    searchContactsSchema,
    searchContacts,
    getContactSchema,
    getContact,
    createContactSchema,
    createContact,
    updateContactSchema,
    updateContact,
    deleteContactSchema,
    deleteContact,
} from './contacts.js';

// Search tools
import {
    searchEmailsSchema,
    searchEmails,
} from './search.js';

// Read tools
import {
    getEmailSchema,
    getEmail,
} from './read.js';

// Send tools
import {
    sendEmailSchema,
    forwardEmailSchema,
    sendEmail,
    forwardEmail,
} from './send.js';

// Organize tools
import {
    moveEmailsSchema,
    deleteEmailsSchema,
    markEmailsSchema,
    tagEmailsSchema,
    moveEmails,
    deleteEmails,
    markEmails,
    tagEmails,
} from './organize.js';

// Calendar/Task tools
import {
    listCalendarsSchema,
    listTasksSchema,
    getTaskSchema,
    createTaskSchema,
    updateTaskSchema,
    completeTaskSchema,
    deleteTaskSchema,
    listEventsSchema,
    getEventSchema,
    createEventSchema,
    updateEventSchema,
    deleteEventSchema,
    listCalendars,
    listTasks,
    getTask,
    createTask,
    updateTask,
    completeTask,
    deleteTask,
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    deleteEvent,
} from './calendar.js';
import { changesSince, changesSinceSchema } from './changes.js';

// Tool definition type
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: z.ZodType;
    handler: (params: unknown) => Promise<unknown>;
}

const accountSelectorSchema = z.string()
    .min(1)
    .optional()
    .describe(
        'Account to use for this call (display name or email). Defaults to the configured default account.'
    );

const accountSelectionSchema = z.object({
    account: accountSelectorSchema,
});

const ACCOUNT_SCOPED_DESCRIPTION =
    'Use the optional account parameter to target a configured account by display name or email for this call.';

export function createAccountScopedTool(tool: ToolDefinition): ToolDefinition {
    if (!(tool.inputSchema instanceof z.ZodObject)) {
        throw new Error(`Account-scoped tool "${tool.name}" must use a Zod object schema`);
    }

    const inputSchema = tool.inputSchema.extend({
        account: accountSelectorSchema,
    });

    return {
        ...tool,
        description: `${tool.description} ${ACCOUNT_SCOPED_DESCRIPTION}`,
        inputSchema,
        handler: async (params) => {
            const parsed = inputSchema.parse(params);
            const { account } = accountSelectionSchema.parse(parsed);

            if (account) {
                const manager = getAccountManager();
                if (!manager.switchAccount(account)) {
                    const available = manager
                        .getAccounts()
                        .map((candidate) => candidate.displayName || candidate.name);
                    throw new Error(
                        `Account "${account}" not found. Available: ${available.join(', ') || 'none configured'}`
                    );
                }
            }

            return tool.handler(parsed);
        },
    };
}

// All tools before account-scoped decoration
const baseTools: ToolDefinition[] = [
    // Account Management
    {
        name: 'list_accounts',
        description: 'List configured accounts and current active account (lightweight).',
        inputSchema: listAccountsSchema,
        handler: listAccounts,
    },
    {
        name: 'switch_account',
        description:
            'Select an account in the current client context. In stateless HTTP, pass account directly to the target tool instead.',
        inputSchema: switchAccountSchema,
        handler: (params) => switchAccount(switchAccountSchema.parse(params)),
    },
    {
        name: 'get_current_account',
        description: 'Get the currently active account (lightweight).',
        inputSchema: getCurrentAccountSchema,
        handler: getCurrentAccount,
    },

    // Mailboxes
    {
        name: 'list_mailboxes',
        description: 'List mailboxes/folders in the current account (lightweight; use to resolve mailbox names/IDs).',
        inputSchema: listMailboxesSchema,
        handler: listMailboxes,
    },
    {
        name: 'create_mailbox',
        description: 'Create a new mailbox/folder in the account.',
        inputSchema: createMailboxSchema,
        handler: (params) => createMailbox(createMailboxSchema.parse(params)),
    },
    {
        name: 'rename_mailbox',
        description: 'Rename an existing mailbox/folder.',
        inputSchema: renameMailboxSchema,
        handler: (params) => renameMailbox(renameMailboxSchema.parse(params)),
    },
    {
        name: 'delete_mailbox',
        description: 'Delete an existing mailbox/folder.',
        inputSchema: deleteMailboxSchema,
        handler: (params) => deleteMailbox(deleteMailboxSchema.parse(params)),
    },
    {
        name: 'move_mailbox',
        description: 'Move a mailbox/folder under a new parent (reorganize hierarchy).',
        inputSchema: moveMailboxSchema,
        handler: (params) => moveMailbox(moveMailboxSchema.parse(params)),
    },
    {
        name: 'get_mailbox_details',
        description: 'Get total and unread email/thread counts for a mailbox.',
        inputSchema: getMailboxDetailsSchema,
        handler: (params) => getMailboxDetails(getMailboxDetailsSchema.parse(params)),
    },
    {
        name: 'set_mailbox_role',
        description: 'Set or clear the standard JMAP role of a mailbox (e.g. "archive", "trash").',
        inputSchema: setMailboxRoleSchema,
        handler: (params) => setMailboxRole(setMailboxRoleSchema.parse(params)),
    },

    // Search & Read
    {
        name: 'search_emails',
        description: 'Search emails with filters and return lightweight results (headers + snippet). Includes the RFC 5322 messageId, inReplyTo and references headers, so deep links and thread grouping need no follow-up fetch. Returns at most 100 per call: check `total` (all matches) against `returned` and `hasMore`, and page with `position` when the set is larger. Use this to narrow scope before calling get_email.',
        inputSchema: searchEmailsSchema,
        handler: (params) => searchEmails(searchEmailsSchema.parse(params)),
    },
    {
        name: 'changes_since',
        description:
            'Incremental mail changes since a previous state, in ONE request -- use this to poll instead of repeating searches. Omit state to get a starting point and no changes. Returns created/updated messages, destroyedIds, and departedIds (changed but now outside the requested mailboxes). If hasMoreChanges is true, call again with the returned state. Throws rather than returning empty when the state is too old to compute changes from; treat that as "resync", never as "nothing changed".',
        inputSchema: changesSinceSchema,
        handler: (params) => changesSince(changesSinceSchema.parse(params)),
    },
    {
        name: 'get_email',
        description: 'Get the full content of an email by ID (body + attachments), including the RFC 5322 messageId, inReplyTo and references headers. Token-expensive; only call for messages you really need -- search_emails already returns those headers.',
        inputSchema: getEmailSchema,
        handler: (params) => getEmail(getEmailSchema.parse(params)),
    },

    // Send & Forward
    {
        name: 'send_email',
        description: 'Compose and send a new email (no email bodies read).',
        inputSchema: sendEmailSchema,
        handler: (params) => sendEmail(sendEmailSchema.parse(params)),
    },
    {
        name: 'forward_email',
        description: 'Forward an existing email by ID (use IDs from search_emails).',
        inputSchema: forwardEmailSchema,
        handler: (params) => forwardEmail(forwardEmailSchema.parse(params)),
    },

    // Bulk Organization
    {
        name: 'move_emails',
        description: 'Move emails by ID (use search_emails to get IDs first).',
        inputSchema: moveEmailsSchema,
        handler: (params) => moveEmails(moveEmailsSchema.parse(params)),
    },
    {
        name: 'delete_emails',
        description: 'Delete emails by ID (use search_emails to get IDs first).',
        inputSchema: deleteEmailsSchema,
        handler: (params) => deleteEmails(deleteEmailsSchema.parse(params)),
    },
    {
        name: 'mark_emails',
        description: 'Mark emails by ID as read/unread/flagged (use search_emails to get IDs first).',
        inputSchema: markEmailsSchema,
        handler: (params) => markEmails(markEmailsSchema.parse(params)),
    },
    {
        name: 'tag_emails',
        description: 'Add/remove keywords on emails by ID (use search_emails to get IDs first).',
        inputSchema: tagEmailsSchema,
        handler: (params) => tagEmails(tagEmailsSchema.parse(params)),
    },

    // Contacts (RFC 9610)
    {
        name: 'list_address_books',
        description: 'List contact address books.',
        inputSchema: listAddressBooksSchema,
        handler: listAddressBooks,
    },
    {
        name: 'search_contacts',
        description: 'Search contacts by name, email, or details.',
        inputSchema: searchContactsSchema,
        handler: (params) => searchContacts(searchContactsSchema.parse(params)),
    },
    {
        name: 'get_contact',
        description: 'Fetch detailed contact information by ID.',
        inputSchema: getContactSchema,
        handler: (params) => getContact(getContactSchema.parse(params)),
    },
    {
        name: 'create_contact',
        description: 'Create a new contact in an address book.',
        inputSchema: createContactSchema,
        handler: (params) => createContact(createContactSchema.parse(params)),
    },
    {
        name: 'update_contact',
        description: 'Update fields of an existing contact.',
        inputSchema: updateContactSchema,
        handler: (params) => updateContact(updateContactSchema.parse(params)),
    },
    {
        name: 'delete_contact',
        description: 'Delete a contact by ID.',
        inputSchema: deleteContactSchema,
        handler: (params) => deleteContact(deleteContactSchema.parse(params)),
    },

    // Calendar & Tasks (CalDAV)
    {
        name: 'list_calendars',
        description: 'List calendars in the current account (lightweight).',
        inputSchema: listCalendarsSchema,
        handler: listCalendars,
    },
    {
        name: 'list_tasks',
        description: 'List tasks with filters; use date/status filters to keep results small.',
        inputSchema: listTasksSchema,
        handler: (params) => listTasks(listTasksSchema.parse(params)),
    },
    {
        name: 'get_task',
        description: 'Get full details of a specific task by URL (use list_tasks first).',
        inputSchema: getTaskSchema,
        handler: (params) => getTask(getTaskSchema.parse(params)),
    },
    {
        name: 'create_task',
        description: 'Create a new task/todo in a calendar',
        inputSchema: createTaskSchema,
        handler: (params) => createTask(createTaskSchema.parse(params)),
    },
    {
        name: 'update_task',
        description: 'Update an existing task (summary, due date, status, priority, etc.)',
        inputSchema: updateTaskSchema,
        handler: (params) => updateTask(updateTaskSchema.parse(params)),
    },
    {
        name: 'complete_task',
        description: 'Mark a task as complete',
        inputSchema: completeTaskSchema,
        handler: (params) => completeTask(completeTaskSchema.parse(params)),
    },
    {
        name: 'delete_task',
        description: 'Delete a task',
        inputSchema: deleteTaskSchema,
        handler: (params) => deleteTask(deleteTaskSchema.parse(params)),
    },

    // Calendar Events (CalDAV)
    {
        name: 'list_events',
        description: 'List calendar events with filters; always use a tight date range + limit.',
        inputSchema: listEventsSchema,
        handler: (params) => listEvents(listEventsSchema.parse(params)),
    },
    {
        name: 'get_event',
        description: 'Get full details of a specific event by URL (use list_events first).',
        inputSchema: getEventSchema,
        handler: (params) => getEvent(getEventSchema.parse(params)),
    },
    {
        name: 'create_event',
        description: 'Create a new calendar event (meeting, appointment, etc.)',
        inputSchema: createEventSchema,
        handler: (params) => createEvent(createEventSchema.parse(params)),
    },
    {
        name: 'update_event',
        description: 'Update an existing event (title, time, location, etc.)',
        inputSchema: updateEventSchema,
        handler: (params) => updateEvent(updateEventSchema.parse(params)),
    },
    {
        name: 'delete_event',
        description: 'Delete a calendar event',
        inputSchema: deleteEventSchema,
        handler: (params) => deleteEvent(deleteEventSchema.parse(params)),
    },
];

const accountManagementTools = new Set([
    'list_accounts',
    'switch_account',
    'get_current_account',
]);

export const tools: ToolDefinition[] = baseTools.map((tool) =>
    accountManagementTools.has(tool.name) ? tool : createAccountScopedTool(tool)
);

// Export individual tools for testing
export {
    listAccounts,
    switchAccount,
    getCurrentAccount,
    listMailboxes,
    changesSince,
    createMailbox,
    renameMailbox,
    deleteMailbox,
    moveMailbox,
    getMailboxDetails,
    setMailboxRole,
    searchEmails,
    getEmail,
    sendEmail,
    forwardEmail,
    moveEmails,
    deleteEmails,
    markEmails,
    tagEmails,
    listAddressBooks,
    searchContacts,
    getContact,
    createContact,
    updateContact,
    deleteContact,
    listCalendars,
    listTasks,
    getTask,
    createTask,
    updateTask,
    completeTask,
    deleteTask,
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    deleteEvent,
};
