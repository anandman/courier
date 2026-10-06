import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type express from 'express';

import { createMcpServer } from './mcp-server.js';
import { getRequestContext } from './request-context.js';

const INITIALIZE_LOG_ENABLED =
    process.env.MCP_ACCESS_LOG === '1' || process.env.MCP_ACCESS_LOG === 'true';

/**
 * Logs the MCP handshake, reading it from the raw body rather than the server's
 * `oninitialized` hook.
 *
 * In stateless mode the `initialized` notification arrives as a separate HTTP
 * request, and therefore reaches a brand-new Server that never saw the
 * `initialize` it acknowledges -- so the hook fires with no client info at all.
 * The body is the only place the client actually names itself.
 */
function logInitialize(body: unknown): void {
    if (!INITIALIZE_LOG_ENABLED) return;

    const message = body as {
        method?: unknown;
        params?: { clientInfo?: unknown; protocolVersion?: unknown; capabilities?: unknown };
    };
    if (message?.method !== 'initialize') return;

    const info = message.params?.clientInfo as { name?: string; version?: string } | undefined;
    const clientId = getRequestContext()?.authInfo?.clientId;
    // Which capabilities a client declares decides what this server may do with
    // it -- elicitation in particular, since a confirmation prompt is only
    // possible where the client can show one. Names only; the objects carry no
    // user data but there is no reason to log their contents.
    const declared = Object.keys(
        (message.params?.capabilities as Record<string, unknown> | undefined) ?? {}
    ).sort();
    console.log(
        `[mcp] initialize from ${info?.name ?? 'unnamed'}${info?.version ? ` ${info.version}` : ''}` +
            ` protocol=${String(message.params?.protocolVersion ?? 'unspecified')}` +
            ` caps=[${declared.join(',')}]` +
            `${clientId ? ` client=${clientId}` : ''}`
    );
}

/**
 * Handles one Streamable HTTP request with an isolated stateless MCP connection.
 *
 * SDK transports retain connection-specific callbacks, so a stateless transport
 * must never be reused across requests. A new Server is paired with it because a
 * Server can only be connected to one transport at a time.
 */
export async function handleStatelessMcpRequest(
    req: express.Request,
    res: express.Response
): Promise<void> {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });

    let closePromise: Promise<void> | undefined;
    const close = () => {
        closePromise ??= server.close();
        return closePromise;
    };

    res.once('close', () => {
        void close().catch(() => undefined);
    });

    try {
        logInitialize(req.body);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } finally {
        if (res.writableEnded || res.destroyed) {
            await close();
        }
    }
}
