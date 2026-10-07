import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { getAccountManager } from './account-manager.js';
import { getRequestContext } from './request-context.js';
import { tools } from './tools/index.js';
import { isToolSupported, unsupportedToolMessage } from './tools/scopes.js';
import { enforce } from './policy/enforce.js';
import { resolvePolicy } from './policy/registry.js';
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
 * Notes that a call ran without a policy check.
 *
 * Deliberately noisy in intent: a deployment with no enforcement must not be
 * indistinguishable from one with it. Rate-limited to once per reason so stdio
 * does not emit a line per call.
 */
const unenforcedReported = new Set<string>();

function logUnenforced(toolName: string, reason: string): void {
    if (unenforcedReported.has(reason)) return;
    unenforcedReported.add(reason);
    console.warn(
        `[policy] not enforced: ${reason}. Tools run unrestricted, starting with ${toolName}.`
    );
}

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
        // One filter, not two. What a client is *permitted* to do is enforced
        // at tools/call and never by hiding a tool: clients cache this list,
        // and several only notice a change when the server is removed and
        // re-added by hand, so a permission change must not alter it.
        //
        // Capability is different. A tool the credential cannot use could only
        // ever 403, which wastes a call and teaches the model nothing.
        const available = await currentCapabilities();
        return {
            tools: tools
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

        const clientId = getRequestContext()?.authInfo?.clientId;

        // A cached tool list can name a tool this token cannot use. Fail here
        // with an explanation instead of spending a round trip to be told
        // "Disallowed capabilities".
        if (!isToolSupported(name, await currentCapabilities())) {
            const message = unsupportedToolMessage(name);
            logToolCall(name, args, startedAt, message);
            throw new Error(message);
        }

        // Per-client permissions. Checked here rather than by hiding tools,
        // because every tool stays advertised: clients cache the list, and
        // several only notice a change when the server is removed and re-added
        // by hand.
        const policy = await resolvePolicy(clientId);
        if (policy.unknownClient) {
            // A valid token for a client the registry has forgotten.
            // verifyAccessToken already rejects this, so arriving here means
            // the two disagree -- refuse rather than judge the call against
            // defaults, which would grant a revoked client everything a new
            // one gets.
            const message =
                'This client is no longer registered with Courier. Remove the server from the application and add it again.';
            logToolCall(name, args, startedAt, message);
            throw new Error(message);
        }

        if (policy.unenforced) {
            // Said once per call at most, and only when the log is on. A server
            // running without enforcement should not be able to look like one
            // running with it.
            logUnenforced(name, policy.unenforced);
        } else {
            const decision = await enforce({
                toolName: name,
                args,
                overrides: policy.overrides,
                canElicit: server.getClientCapabilities()?.elicitation !== undefined,
                elicit: (message) => server.elicitInput({
                    message,
                    requestedSchema: { type: 'object', properties: {} },
                }),
            });

            if (!decision.allowed) {
                logToolCall(name, args, startedAt, decision.reason);
                throw new Error(decision.reason);
            }
        }

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
