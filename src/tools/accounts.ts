/**
 * Account management tools for MCP server
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';

// Tool schemas
export const listAccountsSchema = z.object({});

export const switchAccountSchema = z.object({
    account: z.string().describe(
        'Account to select in the current client context (display name or email). This does not change the user-wide persisted default. In stateless HTTP, pass account directly to the target tool instead.'
    ),
});

export const getCurrentAccountSchema = z.object({});

// Tool handlers
export async function listAccounts(): Promise<{
    accounts: Array<{ email: string; displayName?: string }>;
    currentAccount: string | null;
    currentDisplayName?: string;
    configFilePath: string;
}> {
    const manager = getAccountManager();
    const accounts = manager.getAccounts().map(a => ({
        email: a.name,
        displayName: a.displayName,
    }));
    const current = manager.getCurrentAccount();

    return {
        accounts,
        currentAccount: current?.name || null,
        currentDisplayName: current?.displayName,
        configFilePath: manager.getConfigFilePath(),
    };
}

/**
 * Selects an account for this client context.
 *
 * Throws when the account does not exist, rather than returning
 * `success: false`. The old shape was a failure reported as data: the MCP
 * envelope said the call succeeded, so a caller that checks the envelope --
 * which is the only thing an exit code can be derived from -- saw a switch to a
 * nonexistent account as a success and carried on against whichever account
 * happened to be current. Every other tool already throws for exactly this
 * condition, because createAccountScopedTool does so for its `account`
 * parameter; this one was the exception.
 */
export async function switchAccount(params: z.infer<typeof switchAccountSchema>): Promise<{
    success: true;
    previousAccount: string | null;
    currentAccount: string | null;
    currentDisplayName?: string;
    message: string;
}> {
    const manager = getAccountManager();
    const previousAccount = manager.getCurrentAccountName();

    if (!manager.switchAccount(params.account)) {
        const available = manager.getAccounts().map(a => a.displayName || a.name);
        throw new Error(
            `Account "${params.account}" not found. Available: ${available.join(', ') || 'none configured'}`
        );
    }

    const current = manager.getCurrentAccount();
    const displayLabel = current?.displayName || current?.name;
    return {
        success: true,
        previousAccount,
        currentAccount: current?.name || null,
        currentDisplayName: current?.displayName,
        message: `Switched to "${displayLabel}"`,
    };
}

export async function getCurrentAccount(): Promise<{
    accountName: string | null;
    displayName?: string;
    hasAccounts: boolean;
    message: string;
}> {
    const manager = getAccountManager();
    const current = manager.getCurrentAccount();
    const hasAccounts = manager.hasAccounts();

    if (!hasAccounts) {
        return {
            accountName: null,
            hasAccounts: false,
            message: `No accounts configured. Set COURIER_API_TOKEN environment variable or create ${manager.getConfigFilePath()}`,
        };
    }

    const displayLabel = current?.displayName ? `${current.displayName} (${current.name})` : current?.name;
    return {
        accountName: current?.name || null,
        displayName: current?.displayName,
        hasAccounts: true,
        message: `Current account: ${displayLabel}`,
    };
}
