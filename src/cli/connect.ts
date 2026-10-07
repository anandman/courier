/**
 * The CLI's MCP session, and the translation from "what went wrong" to an exit
 * code.
 *
 * Every failure path in the CLI funnels through `classify` here, which is the
 * only place that decides a number. Spreading that decision across call sites
 * is how a contract drifts: one site maps a 401 to 1, another to 4, and a
 * consumer's `case $?` quietly stops covering reality.
 */

import { createInterface } from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ElicitRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

import { CliError, EXIT } from './exit.js';
import { CliOAuthProvider } from './oauth.js';
import { CredentialStore } from './store.js';

export interface SessionOptions {
    serverUrl: string;
    store: CredentialStore;
    timeoutMs?: number;
    /** `--yes`: confirm in advance anything the server asks about. */
    assumeYes?: boolean;
    /** Progress and prompts, on stderr. */
    log?: (line: string) => void;
}

export interface RemoteTool {
    name: string;
    description?: string;
    inputSchema: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class CourierSession {
    private readonly options: SessionOptions;
    private readonly provider: CliOAuthProvider;
    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    /** Whether any token existed before we tried, which is what separates exit 3 from exit 4. */
    private hadTokens = false;

    constructor(options: SessionOptions) {
        this.options = options;
        this.provider = new CliOAuthProvider({
            serverUrl: options.serverUrl,
            store: options.store,
            // A command that is not `auth login` must never pop a browser. An
            // unattended consumer would hang forever on a window nobody is
            // looking at, which presents as a timeout rather than as the
            // missing credential it actually is.
            onAuthorizationUrl: () => {
                throw new CliError(
                    EXIT.NO_AUTH,
                    'This server requires an interactive authorization that this command cannot perform.',
                    'Run `courier auth login` first.'
                );
            },
        });
    }

    async connect(): Promise<Client> {
        if (this.client) return this.client;

        const stored = await this.options.store.read(this.options.serverUrl);
        this.hadTokens = stored.tokens !== undefined;

        // Refuse up front for a remote server with nothing stored, rather than
        // discovering it from a 401. Letting the request go would make the SDK
        // register a fresh OAuth client before anything could refuse it, so an
        // unattended consumer looping on a lost credential would leave a new
        // provisional registration on the server every single run.
        //
        // Loopback is exempt because a server on this machine may legitimately
        // run with authentication off, and there is no registration to churn
        // when none is required. If it does require auth, the 401 path below
        // still produces the same answer -- one attempt later.
        if (!this.hadTokens && !isLoopback(this.options.serverUrl)) {
            throw new CliError(
                EXIT.NO_AUTH,
                `No stored credentials for ${this.options.serverUrl}.`,
                'Run `courier auth login` to authorize this machine.'
            );
        }

        // Declares elicitation, and means it.
        //
        // The server's `confirm` tier asks a human before a tool that changes
        // something, and refuses when nobody can be asked -- correctly, since
        // treating "could not ask" as consent would turn every confirm into an
        // allow for exactly the unattended clients it exists to constrain. A
        // client that did not declare this would simply be refused those tools.
        //
        // So the CLI answers properly: `--yes` is the human having already
        // agreed, a terminal means asking them now, and neither means declining.
        const client = new Client(
            { name: 'courier-cli', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            const message = request.params.message;
            return this.answerElicitation(message);
        });
        const transport = new StreamableHTTPClientTransport(new URL(this.options.serverUrl), {
            authProvider: this.provider,
        });

        try {
            await client.connect(transport);
        } catch (error) {
            await transport.close().catch(() => undefined);
            throw this.classify(error);
        }

        this.client = client;
        this.transport = transport;
        return client;
    }

    async listTools(): Promise<RemoteTool[]> {
        const client = await this.connect();
        try {
            const result = await client.listTools(undefined, { timeout: this.timeout });
            return result.tools as RemoteTool[];
        } catch (error) {
            throw this.classify(error);
        }
    }

    /**
     * Calls a tool and returns its payload, or throws with an exit code.
     *
     * Both of MCP's failure shapes are checked. The second one -- `isError` on
     * an otherwise successful JSON-RPC response -- is the reason this method
     * exists at all rather than callers using the SDK directly: a client that
     * reads `content[].text` and stops has just turned a dead credential into
     * an empty result, and that exact omission has already cost this project a
     * day of a consumer's mail.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const client = await this.connect();

        let result;
        try {
            result = await client.callTool({ name, arguments: args }, undefined, {
                timeout: this.timeout,
            });
        } catch (error) {
            throw this.classify(error);
        }

        const envelope = result as Record<string, unknown>;
        if (envelope.isError === true) {
            throw new CliError(EXIT.TOOL_ERROR, extractErrorMessage(envelope));
        }

        return unwrapPayload(envelope, name);
    }

    async close(): Promise<void> {
        await this.transport?.close().catch(() => undefined);
        this.client = null;
        this.transport = null;
    }

    private get timeout(): number {
        return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * Answers the server's confirmation prompt.
     *
     * Declines rather than cancels when there is nobody to ask: `decline` is a
     * decision and `cancel` is a dismissal, and "this invocation has no human"
     * is the former. Either way the server refuses, but the message the user
     * eventually reads should say which happened.
     */
    private async answerElicitation(message: string): Promise<{ action: 'accept' | 'decline'; content?: Record<string, never> }> {
        const log = this.options.log ?? (() => undefined);

        if (this.options.assumeYes) {
            log(`${message} -- confirmed in advance by --yes.`);
            return { action: 'accept', content: {} };
        }

        if (!process.stdin.isTTY) {
            return { action: 'decline' };
        }

        process.stderr.write(`\n${message}\n`);
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
            const answer = await new Promise<string>((resolve) => rl.question('Allow? [y/N] ', resolve));
            return /^y(es)?$/i.test(answer.trim()) ? { action: 'accept', content: {} } : { action: 'decline' };
        } finally {
            rl.close();
        }
    }

    /**
     * The single mapping from a thrown thing to an exit code.
     *
     * Order matters: an UnauthorizedError wrapping a network failure is still
     * an auth problem from the SDK's point of view, but the useful answer for
     * the caller is the transport one, so network codes are checked first.
     */
    private classify(error: unknown): CliError {
        if (error instanceof CliError) return error;

        const message = error instanceof Error ? error.message : String(error);
        const code = networkCodeOf(error);

        if (code) {
            return new CliError(
                EXIT.UNREACHABLE,
                `Could not reach ${this.options.serverUrl}: ${message}`,
                'The server may be down. This is safe to retry.'
            );
        }

        if (error instanceof UnauthorizedError) {
            // Having had a token and still being refused means something was
            // revoked -- the token, the refresh grant, or the registration
            // itself. That is a different event from never having logged in,
            // and it is the one worth noticing.
            return this.hadTokens
                ? new CliError(
                      EXIT.AUTH_REJECTED,
                      `${this.options.serverUrl} rejected the stored credentials and they could not be renewed: ${message}`,
                      'Run `courier auth login` to authorize again.'
                  )
                : new CliError(
                      EXIT.NO_AUTH,
                      `${this.options.serverUrl} requires authorization.`,
                      'Run `courier auth login` first.'
                  );
        }

        if (error instanceof McpError) {
            return new CliError(EXIT.TOOL_ERROR, message);
        }

        if (/timed out|timeout/i.test(message)) {
            return new CliError(
                EXIT.UNREACHABLE,
                `Timed out waiting for ${this.options.serverUrl}: ${message}`,
                'This is safe to retry.'
            );
        }

        // HTTP failures the transport surfaces as plain errors. 5xx is the
        // server failing to answer; 4xx other than 401 is a protocol-level
        // refusal of the request itself.
        const status = httpStatusOf(message);
        if (status !== undefined) {
            if (status === 401 || status === 403) {
                return new CliError(
                    EXIT.AUTH_REJECTED,
                    `${this.options.serverUrl} refused the request: HTTP ${status}.`,
                    'Run `courier auth login` to authorize again.'
                );
            }
            if (status >= 500) {
                return new CliError(
                    EXIT.UNREACHABLE,
                    `${this.options.serverUrl} returned HTTP ${status}: ${message}`,
                    'This is safe to retry.'
                );
            }
            return new CliError(EXIT.TOOL_ERROR, `${this.options.serverUrl} returned HTTP ${status}: ${message}`);
        }

        return new CliError(EXIT.INTERNAL, message);
    }
}

/**
 * Pulls the payload out of an MCP tool result.
 *
 * Courier answers with one text block holding JSON, so that is the fast path.
 * The guard that matters is the last one: a result with nothing in it is not an
 * empty answer, it is an unreadable one, and printing `{}` for it would
 * reproduce the exact confusion this CLI exists to prevent.
 */
export function unwrapPayload(result: Record<string, unknown>, toolName: string): unknown {
    if (result.structuredContent !== undefined) return result.structuredContent;

    const blocks = Array.isArray(result.content) ? result.content : [];
    const texts = blocks
        .filter((block): block is { type: string; text: string } =>
            typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
        )
        .map((block) => block.text);

    if (texts.length === 1) {
        const parsed = tryParseJson(texts[0]);
        return parsed === undefined ? texts[0] : parsed;
    }

    if (texts.length > 1) {
        return texts.map((text) => tryParseJson(text) ?? text);
    }

    // Non-text blocks (images, resources) are returned as they came rather than
    // being flattened into something lossy.
    if (blocks.length > 0) return blocks;

    throw new CliError(
        EXIT.TOOL_ERROR,
        `${toolName} returned a result with no content, so there is no answer to print.`
    );
}

function tryParseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function extractErrorMessage(result: Record<string, unknown>): string {
    const blocks = Array.isArray(result.content) ? result.content : [];
    for (const block of blocks) {
        if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
            const text = (block as { text: string }).text;
            const parsed = tryParseJson(text);
            if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
                return (parsed as { error: string }).error;
            }
            return text;
        }
    }
    return 'The tool reported an error but gave no message.';
}

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Walks the cause chain, because fetch buries the real code one or two levels down. */
function networkCodeOf(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
        if (current instanceof TypeError && /fetch failed/i.test(current.message)) return 'ECONNREFUSED';
        current = (current as { cause?: unknown }).cause;
    }
    return undefined;
}

/** Whether a server runs on this machine, where authentication may be off. */
export function isLoopback(serverUrl: string): boolean {
    try {
        const hostname = new URL(serverUrl).hostname;
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
    } catch {
        return false;
    }
}

function httpStatusOf(message: string): number | undefined {
    const match = /\b(?:HTTP|status(?:\s+code)?:?)\s*(\d{3})\b/i.exec(message);
    if (!match) return undefined;
    const status = Number.parseInt(match[1], 10);
    return status >= 100 && status <= 599 ? status : undefined;
}
