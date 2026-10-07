import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
    AccountManager,
    getAccountManager,
    type ExtendedMultiAccountConfig,
} from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import {
    createAccountScopedTool,
    switchAccount,
    tools,
    type ToolDefinition,
} from '../src/tools/index.js';

const initialConfig: ExtendedMultiAccountConfig = {
    accounts: [
        {
            name: 'personal@example.com',
            displayName: 'Personal',
            token: 'personal-token',
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        },
        {
            name: 'work@example.com',
            displayName: 'Work',
            token: 'work-token',
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        },
    ],
    defaultAccount: 'personal@example.com',
};

function createManager(
    onChange?: (config: ExtendedMultiAccountConfig) => void
): AccountManager {
    return new AccountManager({
        initialConfig,
        allowEnv: false,
        allowConfigFile: false,
        onChange,
    });
}

describe('per-call account selection', () => {
    it('publishes an optional account selector on every account-scoped tool', () => {
        const accountManagementTools = new Set([
            'list_accounts',
            'switch_account',
            'get_current_account',
        ]);
        const accountScopedTools = tools.filter(
            (tool) => !accountManagementTools.has(tool.name)
        );

        expect(accountScopedTools.length).toBeGreaterThan(0);

        for (const tool of accountScopedTools) {
            const jsonSchema = zodToJsonSchema(tool.inputSchema) as {
                properties?: Record<string, unknown>;
                required?: string[];
            };

            expect(jsonSchema.properties, tool.name).toHaveProperty('account');
            expect(jsonSchema.required ?? [], tool.name).not.toContain('account');
        }
    });

    it('targets a non-default account for one request without persisting it', async () => {
        const persistedConfigs: ExtendedMultiAccountConfig[] = [];
        const manager = createManager((config) => persistedConfigs.push(config));
        const probeSchema = z.object({ value: z.string() });
        const probeTool: ToolDefinition = createAccountScopedTool({
            name: 'probe',
            description: 'Inspect the selected account.',
            inputSchema: probeSchema,
            handler: async (params) => {
                const parsed = probeSchema.parse(params);
                return {
                    activeAccount: getAccountManager().getCurrentAccountName(),
                    value: parsed.value,
                };
            },
        });

        const result = await runWithRequestContext(
            { accountManager: manager },
            () => probeTool.handler({ account: 'Work', value: 'selected' })
        );

        expect(result).toEqual({
            activeAccount: 'work@example.com',
            value: 'selected',
        });
        expect(manager.exportConfig().defaultAccount).toBe('personal@example.com');
        expect(persistedConfigs).toHaveLength(0);

        const nextRequestManager = createManager();
        expect(nextRequestManager.getCurrentAccountName()).toBe(
            'personal@example.com'
        );
    });

    it('uses the default when omitted and rejects an unknown account', async () => {
        const manager = createManager();
        const handler = vi.fn(async () =>
            getAccountManager().getCurrentAccountName()
        );
        const tool = createAccountScopedTool({
            name: 'probe',
            description: 'Inspect the selected account.',
            inputSchema: z.object({}),
            handler,
        });

        await expect(
            runWithRequestContext({ accountManager: manager }, () =>
                tool.handler({})
            )
        ).resolves.toBe('personal@example.com');
        await expect(
            runWithRequestContext({ accountManager: manager }, () =>
                tool.handler({ account: 'Missing' })
            )
        ).rejects.toThrow(
            'Account "Missing" not found. Available: Personal, Work'
        );
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('switch_account on an account that does not exist', () => {
    /**
     * It used to answer `success: false` with a message, which left the MCP
     * envelope reporting a successful call. A client that reads the envelope --
     * which is all an exit code or an isError check can see -- took that as a
     * completed switch and carried on against whichever account was already
     * current, silently operating on the wrong mailbox.
     *
     * Throwing matches createAccountScopedTool, which already refuses an
     * unknown `account` parameter the same way on every other tool.
     */
    it('throws instead of reporting failure as data', async () => {
        const manager = createManager();
        await runWithRequestContext({ accountManager: manager }, async () => {
            await expect(switchAccount({ account: 'nobody@example.com' })).rejects.toThrow(
                /not found/
            );
        });
    });

    it('names the accounts that do exist', async () => {
        const manager = createManager();
        await runWithRequestContext({ accountManager: manager }, async () => {
            await expect(switchAccount({ account: 'nobody@example.com' })).rejects.toThrow(
                /Personal/
            );
        });
    });

    it('still switches to an account that does exist', async () => {
        const manager = createManager();
        await runWithRequestContext({ accountManager: manager }, async () => {
            const result = await switchAccount({ account: 'Work' });
            expect(result.success).toBe(true);
            expect(result.currentAccount).toBe('work@example.com');
        });
    });
});
