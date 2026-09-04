import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { getAccountManager } from './account-manager.js';
import { getRequestContext } from './request-context.js';
import { recordToolListServed, shouldNotifyToolListChanged } from './tool-list-watch.js';
import { tools } from './tools/index.js';
import { isToolVisible } from './tools/groups.js';
import { isToolSupported, unsupportedToolMessage } from './tools/scopes.js';
import { getClient } from 'jmap-courier';

const isEnabled = (value: string | undefined) => value === '1' || value === 'true';

/**
 * What the current account's token is permitted to do, or null when that cannot
 * be determined.
 *
 * The session is fetched once per account and cached on the client, which is
 * itself cached, so this is a network call the first time and a map lookup
 * afterwards -- cheap enough to consult on every tools/list.
 *
 * Every failure yields null, which permits everything. A server that hid all of
 * its tools because a session fetch timed out would look broken rather than
 * restricted, and the tool call itself still fails safely with a clear message.
 */
async function currentCapabilities(): Promise<ReadonlySet<string> | null> {
    try {
        const account = getAccountManager().getCurrentAccount();
        if (!account) return null;
        return await getClient(account).getCapabilities();
    } catch {
        return null;
    }
}

/** Opt-in, matching MCP_ACCESS_LOG: one line per tool call. */
const TOOL_LOG_ENABLED = isEnabled(process.env.MCP_TOOL_LOG);

/**
 * Logs a tool call by name and argument *keys* only.
 *
 * Values are never logged: search_emails carries query text and sender
 * addresses, send_email carries recipients and message bodies. This is the same
 * rule the access log follows one level up, where headers are omitted so
 * Authorization never reaches the journal.
 */
function logToolCall(name: string, args: unknown, startedAt: number, error?: string): void {
    if (!TOOL_LOG_ENABLED) return;
    const keys = args && typeof args === 'object' ? Object.keys(args as object).sort() : [];
    const duration = Date.now() - startedAt;
    const outcome = error ? `error=${JSON.stringify(error)}` : 'ok';
    console.log(`[tool] ${name} args=[${keys.join(',')}] ${duration}ms ${outcome}`);
}

export function createMcpServer(): Server {
    const server = new Server(
        {
            name: 'email-courier',
            version: '1.0.0',
        },
        {
            capabilities: {
                // listChanged advertises that the tool list can change during a
                // connection. Without it a conforming client is entitled to
                // ignore the notification entirely.
                tools: { listChanged: true },
            },
        }
    );

    // Handshake logging lives in the HTTP transport, not here: in stateless mode
    // `oninitialized` fires on a different Server instance than the one that
    // handled `initialize`, so it has no client info to report.

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const disabled = getAccountManager().getDisabledToolGroups();
        // Two independent filters. Tool groups are what the user chose to see;
        // capabilities are what the credential can actually do. Offering a tool
        // that can only ever 403 wastes a call and teaches the model nothing.
        const available = await currentCapabilities();
        recordToolListServed(getRequestContext()?.authInfo?.clientId);
        return {
            tools: tools
                .filter((tool) => isToolVisible(tool.name, disabled))
                .filter((tool) => isToolSupported(tool.name, available))
                .map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: zodToJsonSchema(tool.inputSchema),
                })),
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;
        const startedAt = Date.now();

        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }

        const manager = getAccountManager();
        const clientId = getRequestContext()?.authInfo?.clientId;

        // Hiding a tool from tools/list is not enough on its own: clients cache
        // that list, and a client holding a stale copy would keep calling a tool
        // the user has since turned off. Enforce the preference here too, where
        // the call actually happens.
        if (!isToolVisible(name, manager.getDisabledToolGroups())) {
            const message = `Tool "${name}" is turned off for this account. Enable it in Courier's settings to use it.`;
            logToolCall(name, args, startedAt, message);
            await notifyToolListChanged(extra, clientId, manager.getToolSettingsUpdatedAt());
            throw new Error(message);
        }

        // Same reasoning as the visibility check above: a cached tool list can
        // name a tool this token cannot use. Fail here with an explanation
        // instead of spending a round trip to be told "Disallowed capabilities".
        if (!isToolSupported(name, await currentCapabilities())) {
            const message = unsupportedToolMessage(name);
            logToolCall(name, args, startedAt, message);
            throw new Error(message);
        }

        // Piggyback the staleness notification on this request's stream. It
        // arrives too late to affect the call in progress -- the model chose
        // this tool from the list it already had -- but it corrects the next turn.
        await notifyToolListChanged(extra, clientId, manager.getToolSettingsUpdatedAt());

        try {
            const result = await tool.handler(args || {});
            logToolCall(name, args, startedAt);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolCall(name, args, startedAt, message);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ error: message }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    });

    return server;
}

type NotificationSender = { sendNotification: (n: { method: string }) => Promise<void> };

async function notifyToolListChanged(
    extra: unknown,
    clientId: string | undefined,
    settingsUpdatedAt: number | undefined
): Promise<void> {
    if (!shouldNotifyToolListChanged(clientId, settingsUpdatedAt)) return;

    const sender = extra as NotificationSender | undefined;
    if (typeof sender?.sendNotification !== 'function') return;

    // Best-effort. A client that cannot receive this still gets the refusal,
    // so failing to deliver must never fail the call.
    try {
        await sender.sendNotification({ method: 'notifications/tools/list_changed' });
        // Record the settings version the client has now been told about, not
        // the wall clock. Stamping "now" would re-notify on every subsequent
        // call whenever the two clocks disagree, and the point is to say this
        // once per change.
        recordToolListServed(clientId, settingsUpdatedAt);
    } catch {
        // Ignored: delivery is opportunistic, not a correctness requirement.
    }
}
