/**
 * Mailbox tools for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Mailbox } from 'jmap-courier';

// Tool schemas
export const listMailboxesSchema = z.object({});

// Tool handlers
export async function listMailboxes(): Promise<{
    mailboxes: Array<{
        id: string;
        name: string;
        role: string | null;
        unreadCount: number;
        totalCount: number;
        path: string;
        isSubscribed: boolean;
    }>;
    account: string | null;
}> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const mailboxes = await client.getMailboxes();

    // Build mailbox paths (for nested mailboxes)
    const mailboxMap = new Map<string, Mailbox>();
    for (const mb of mailboxes) {
        mailboxMap.set(mb.id, mb);
    }

    function getPath(mb: Mailbox): string {
        if (!mb.parentId) {
            return mb.name;
        }
        const parent = mailboxMap.get(mb.parentId);
        if (!parent) {
            return mb.name;
        }
        return `${getPath(parent)}/${mb.name}`;
    }

    // Sort by role importance, then by name
    const roleOrder: Record<string, number> = {
        'inbox': 0,
        'drafts': 1,
        'sent': 2,
        'archive': 3,
        'trash': 4,
        'junk': 5,
    };

    const sortedMailboxes = [...mailboxes].sort((a, b) => {
        const aOrder = a.role ? (roleOrder[a.role] ?? 10) : 10;
        const bOrder = b.role ? (roleOrder[b.role] ?? 10) : 10;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
    });

    return {
        mailboxes: sortedMailboxes.map(mb => ({
            id: mb.id,
            name: mb.name,
            role: mb.role,
            unreadCount: mb.unreadEmails,
            totalCount: mb.totalEmails,
            path: getPath(mb),
            // Reported, but NOT a signal for "is this folder real".
            //
            // That was the intention, and measuring it killed the idea: on a
            // live Fastmail account the Inbox itself -- 124,500 messages, the
            // role=inbox mailbox -- is isSubscribed: false, while an empty
            // leftover named "Archives" is true. A model told to prefer
            // subscribed folders would skip the Inbox.
            //
            // What actually separates a real folder from a migration leftover
            // is already here: the ROLE, and `totalCount`, and the `path` --
            // the leftovers on that account sit under "migrated/".
            isSubscribed: mb.isSubscribed,
        })),
        account: manager.getCurrentAccountName(),
    };
}

export const createMailboxSchema = z.object({
    name: z.string().describe('Name of the new mailbox/folder'),
    parentId: z.string().optional().describe('ID of the parent mailbox (for nested folder structure)'),
});

export async function createMailbox(params: z.infer<typeof createMailboxSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const created = await client.createMailbox(params.name, params.parentId);

    return {
        success: true,
        mailbox: {
            id: created.id,
            name: created.name,
            parentId: created.parentId,
            role: created.role,
        },
        account: manager.getCurrentAccountName(),
    };
}

export const renameMailboxSchema = z.object({
    id: z.string().describe('ID of the mailbox to rename'),
    name: z.string().describe('New name for the mailbox'),
});

export async function renameMailbox(params: z.infer<typeof renameMailboxSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    await client.renameMailbox(params.id, params.name);

    return {
        success: true,
        id: params.id,
        name: params.name,
        account: manager.getCurrentAccountName(),
    };
}

export const deleteMailboxSchema = z.object({
    id: z.string().describe('ID of the mailbox to delete'),
    onDestroyRemoveEmails: z.boolean().optional().default(false).describe('If true, removes emails from the mailbox instead of failing if not empty'),
});

export async function deleteMailbox(params: z.infer<typeof deleteMailboxSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    await client.deleteMailbox(params.id, params.onDestroyRemoveEmails);

    return {
        success: true,
        id: params.id,
        account: manager.getCurrentAccountName(),
    };
}

export const moveMailboxSchema = z.object({
    id: z.string().describe('ID of the mailbox to move'),
    parentId: z.string().nullable().describe('ID of the new parent mailbox, or null for root level'),
});

export async function moveMailbox(params: z.infer<typeof moveMailboxSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    await client.moveMailbox(params.id, params.parentId);

    return {
        success: true,
        id: params.id,
        parentId: params.parentId,
        account: manager.getCurrentAccountName(),
    };
}

export const getMailboxDetailsSchema = z.object({
    id: z.string().describe('ID of the mailbox'),
});

export async function getMailboxDetails(params: z.infer<typeof getMailboxDetailsSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const mailboxes = await client.getMailboxes();
    const mb = mailboxes.find(m => m.id === params.id);

    if (!mb) {
        throw new Error(`Mailbox not found: ${params.id}`);
    }

    return {
        mailbox: {
            id: mb.id,
            name: mb.name,
            parentId: mb.parentId,
            role: mb.role,
            totalEmails: mb.totalEmails,
            unreadEmails: mb.unreadEmails,
            totalThreads: mb.totalThreads,
            unreadThreads: mb.unreadThreads,
            isSubscribed: mb.isSubscribed,
        },
        account: manager.getCurrentAccountName(),
    };
}

export const setMailboxRoleSchema = z.object({
    id: z.string().describe('ID of the mailbox'),
    role: z.string().nullable().describe('Role to set (e.g. "inbox", "archive", "trash", "drafts", "sent", "junk") or null to clear role'),
});

export async function setMailboxRole(params: z.infer<typeof setMailboxRoleSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    // In JMAP Mailbox/set, update field takes role
    const response = await client.request([
        ['Mailbox/set', {
            accountId: client.getAccountId(),
            update: {
                [params.id]: {
                    role: params.role,
                }
            }
        }, 'a']
    ]);

    const [responseName, result] = response.methodResponses[0];
    if (responseName === 'error') {
        throw new Error(`Mailbox/set failed: ${JSON.stringify(result)}`);
    }

    const setResult = result as {
        notUpdated?: Record<string, { type: string; description?: string }>;
    };

    if (setResult.notUpdated && Object.keys(setResult.notUpdated).length > 0) {
        throw new Error(`Failed to update mailbox role: ${JSON.stringify(setResult.notUpdated)}`);
    }

    return {
        success: true,
        id: params.id,
        role: params.role,
        account: manager.getCurrentAccountName(),
    };
}
