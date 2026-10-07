/**
 * The Courier command line.
 *
 * One binary, two jobs. `courier mcp` is the server, unchanged. Everything else
 * is a client: it authorizes against a running Courier over OAuth and calls
 * tools through MCP. That split is the whole point -- a consumer gets a token
 * it can hold, and the JMAP token and DAV app password stay on the server in
 * exactly one copy each.
 *
 * Two rules the rest of this file exists to keep:
 *
 *   stdout carries data, and only on success. stderr carries everything a
 *   person reads. A caller can pipe stdout into a cache without ever risking
 *   that a diagnostic lands in it.
 *
 *   A non-zero exit prints nothing on stdout. See ./exit.ts for why.
 */

import { createInterface } from 'node:readline';

import { parseToolArgs, describeParameters, missingRequired, normalizeToolName, type JsonSchemaLike } from './args.js';
import { CourierSession } from './connect.js';
import { localToolSchema } from './local-tools.js';
import { CliError, EXIT, describeExitCodes } from './exit.js';
import { beginLogin, completeLogin, login } from './oauth.js';
import { DEFAULT_MAX_PAGES, asPage, collectAllPages, pageSizeForAll } from './paging.js';
import { CredentialStore, credentialKey, tokenExpiry } from './store.js';
import { consequenceOf, defaultTierFor } from '../policy/tiers.js';
import { confirmationReason, requiresConfirmation } from './tiers.js';

const VERSION = '1.0.0';

/**
 * Flags the CLI itself consumes, stripped before a tool ever sees them.
 *
 * Published so tests/cli-globals.test.ts can assert that no tool has a
 * parameter of the same name. A collision would make that parameter
 * unreachable: the global would swallow its value and the flag would look
 * accepted while doing nothing.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
    '--server',
    '--code',
    '--all',
    '--max-pages',
    '--timeout',
    '--yes',
    '-y',
    '--pretty',
    '--compact',
    '--quiet',
    '--no-browser',
    '--remote',
    '--args-json',
]);

interface GlobalOptions {
    server?: string;
    /** The code, or full redirect URL, that finishes a login started elsewhere. */
    code?: string;
    all: boolean;
    maxPages?: number;
    timeoutMs?: number;
    yes: boolean;
    pretty?: boolean;
    quiet: boolean;
    noBrowser: boolean;
    remote: boolean;
    argsJson?: Record<string, unknown>;
}

function note(options: GlobalOptions, line: string): void {
    if (!options.quiet) process.stderr.write(`${line}\n`);
}

function emit(value: unknown, options: GlobalOptions): void {
    const pretty = options.pretty ?? process.stdout.isTTY === true;
    process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

export async function run(argv: string[]): Promise<number> {
    const { options, rest } = extractGlobals(argv);
    const command = rest[0];

    if (!command || command === 'help' || command === '--help' || command === '-h') {
        return handleHelp(rest.slice(1), options);
    }

    if (command === 'version' || command === '--version' || command === '-V') {
        process.stdout.write(`${VERSION}\n`);
        return EXIT.OK;
    }

    if (command === 'exit-codes') {
        emit(describeExitCodes(), options);
        return EXIT.OK;
    }

    if (command === 'mcp') {
        return startServer(rest.slice(1));
    }

    if (command === 'auth') {
        return handleAuth(rest.slice(1), options);
    }

    if (command === 'tools') {
        return handleTools(options);
    }

    if (command === 'call') {
        const toolName = rest[1];
        if (!toolName) {
            throw new CliError(EXIT.USAGE, 'call needs a tool name.', 'Run `courier tools` to list them.');
        }
        return handleCall(toolName, rest.slice(2), options);
    }

    // Bare tool name: `courier search-emails --query foo`. Checked last so a
    // future subcommand can never be shadowed by a tool of the same name.
    return handleCall(command, rest.slice(1), options);
}

/**
 * Pulls the CLI's own flags out of argv wherever they appear.
 *
 * Order-independent on purpose: `courier --server X search-emails` and
 * `courier search-emails --server X` are the same command, and making the user
 * remember which half of the line a flag belongs to is a tax with no return.
 * The cost is that a tool may not have a parameter named like a global one,
 * which is checked by tests/cli-globals.test.ts.
 */
export function extractGlobals(argv: string[]): { options: GlobalOptions; rest: string[] } {
    const options: GlobalOptions = { all: false, yes: false, quiet: false, noBrowser: false, remote: false };
    const rest: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const equals = token.indexOf('=');
        const flag = equals === -1 ? token : token.slice(0, equals);
        const inline = equals === -1 ? undefined : token.slice(equals + 1);
        const takeValue = (): string => {
            const value = inline ?? argv[index + 1];
            if (value === undefined) throw new CliError(EXIT.USAGE, `${flag} needs a value.`);
            if (inline === undefined) index += 1;
            return value;
        };

        switch (flag) {
            case '--server':
                options.server = takeValue();
                continue;
            case '--code':
                options.code = takeValue();
                continue;
            case '--all':
                options.all = true;
                continue;
            case '--max-pages': {
                const pages = Number(takeValue());
                if (!Number.isInteger(pages) || pages <= 0) {
                    throw new CliError(EXIT.USAGE, '--max-pages takes a positive whole number.');
                }
                options.maxPages = pages;
                continue;
            }
            case '--timeout': {
                const seconds = Number(takeValue());
                if (!Number.isFinite(seconds) || seconds <= 0) {
                    throw new CliError(EXIT.USAGE, '--timeout takes a positive number of seconds.');
                }
                options.timeoutMs = Math.round(seconds * 1000);
                continue;
            }
            case '--yes':
            case '-y':
                options.yes = true;
                continue;
            case '--pretty':
                options.pretty = true;
                continue;
            case '--compact':
                options.pretty = false;
                continue;
            case '--quiet':
                options.quiet = true;
                continue;
            case '--no-browser':
                options.noBrowser = true;
                continue;
            case '--remote':
                options.remote = true;
                continue;
            case '--args-json': {
                const raw = takeValue();
                let parsed: unknown;
                try {
                    parsed = JSON.parse(raw);
                } catch (error) {
                    throw new CliError(EXIT.USAGE, `--args-json does not parse: ${(error as Error).message}`);
                }
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new CliError(EXIT.USAGE, '--args-json takes a JSON object.');
                }
                options.argsJson = parsed as Record<string, unknown>;
                continue;
            }
            default:
                rest.push(token);
        }
    }

    return { options, rest };
}

/**
 * Which server to talk to.
 *
 * Falls back to the only stored server when there is exactly one, because that
 * is unambiguous and saves a flag on every single invocation. With two or more
 * it refuses rather than picking: guessing which Courier a command meant is how
 * a command lands on the wrong mailbox.
 */
async function resolveServer(options: GlobalOptions, store: CredentialStore): Promise<string> {
    const explicit = options.server ?? process.env.COURIER_SERVER;
    if (explicit) return explicit.trim();

    const stored = await store.listServers();
    if (stored.length === 1) return stored[0];

    if (stored.length === 0) {
        throw new CliError(
            EXIT.USAGE,
            'No server specified and none is stored.',
            'Pass --server https://host/mcp, or set COURIER_SERVER.'
        );
    }

    throw new CliError(
        EXIT.USAGE,
        `More than one server is stored, so --server is required: ${stored.join(', ')}`,
        'Pass --server, or set COURIER_SERVER.'
    );
}

/**
 * `courier mcp` -- run the server.
 *
 * Delegates to the existing entry point rather than reimplementing it, and sets
 * MCP_TRANSPORT only when the caller asked for a transport, so an environment
 * that already configures one (a systemd unit, for instance) keeps working
 * unchanged.
 */
async function startServer(argv: string[]): Promise<number> {
    for (const token of argv) {
        if (token === '--stdio') {
            process.env.MCP_TRANSPORT = 'stdio';
        } else if (token === '--http') {
            process.env.MCP_TRANSPORT = 'http';
        } else {
            throw new CliError(EXIT.USAGE, `Unknown option for \`courier mcp\`: ${token}`, 'Use --stdio or --http.');
        }
    }

    // Importing runs the server's own main(), which never returns while it is
    // listening, so nothing after this line executes in the normal case.
    await import('../index.js');
    return EXIT.OK;
}

async function handleAuth(argv: string[], options: GlobalOptions): Promise<number> {
    const store = new CredentialStore();
    const sub = argv[0];

    if (sub === 'login') {
        const serverUrl = await resolveServerForLogin(options, store);
        const log = (line: string) => note(options, line);

        // Finishing a login started by an earlier invocation. Checked first so
        // `--code` stands on its own and needs no companion flag.
        if (options.code !== undefined) {
            const result = await completeLogin({ serverUrl, store, code: options.code, log });
            emit(
                { authorized: true, server: credentialKey(result.serverUrl), clientId: result.clientId },
                options
            );
            return EXIT.OK;
        }

        // Without a terminal there is nobody to paste a code at, so the flow
        // splits into two commands rather than prompting into the void.
        if (!process.stdin.isTTY) {
            const result = await beginLogin({ serverUrl, store, log });
            emit(
                {
                    authorized: result.authorized,
                    server: credentialKey(result.serverUrl),
                    clientId: result.clientId,
                    authorizationUrl: result.authorizationUrl,
                    // Stated so a wrapper does not have to know the command.
                    next: result.authorized
                        ? null
                        : `courier auth login --server ${credentialKey(result.serverUrl)} --code "<code>"`,
                },
                options
            );
            return EXIT.OK;
        }

        const result = await login({
            serverUrl,
            store,
            remote: options.remote,
            noBrowser: options.noBrowser,
            log,
        });
        // No prose confirmation: the emitted object says `authorized: true` and
        // names the server, so a sentence above it repeating both is noise at
        // the one moment the user is reading carefully.
        emit({ authorized: true, server: credentialKey(result.serverUrl), clientId: result.clientId }, options);
        return EXIT.OK;
    }

    if (sub === 'status') {
        const serverUrl = await resolveServer(options, store);
        const credentials = await store.read(serverUrl);
        const expiresAt = tokenExpiry(credentials);

        if (!credentials.tokens) {
            // Not an answer printed on stdout, because a script testing
            // `courier auth status` expects zero to mean "usable" -- and this
            // is the case where it is not.
            throw new CliError(
                EXIT.NO_AUTH,
                `No credentials stored for ${credentialKey(serverUrl)}.`,
                'Run `courier auth login`.'
            );
        }

        emit(
            {
                server: credentialKey(serverUrl),
                clientId: credentials.client?.client_id,
                hasRefreshToken: credentials.tokens.refresh_token !== undefined,
                // Stated as unknown rather than guessed when the server did not
                // say, and never used to claim the token still works: only a
                // request can establish that.
                accessTokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                accessTokenExpired: expiresAt ? expiresAt <= Date.now() : null,
                credentialsFile: store.path,
            },
            options
        );
        return EXIT.OK;
    }

    if (sub === 'logout') {
        const serverUrl = await resolveServer(options, store);
        const forgotten = await store.forget(serverUrl);
        note(
            options,
            forgotten
                ? `Forgot the credentials for ${credentialKey(serverUrl)}.`
                : `Nothing was stored for ${credentialKey(serverUrl)}.`
        );
        // Deliberately not an error when there was nothing to forget: logout is
        // idempotent, and a cleanup script should not have to care.
        emit({ forgotten, server: credentialKey(serverUrl) }, options);
        return EXIT.OK;
    }

    if (sub === 'list' || sub === undefined) {
        // Says whether each server is actually authorized, not just that it is
        // known. A registration is stored as soon as `auth login` starts, and
        // is kept even when the login is abandoned -- deliberately, so the next
        // attempt reuses the client_id instead of leaving another provisional
        // registration on the server. That makes a bare list of names
        // misleading: it would show a server the CLI cannot call as though a
        // credential existed.
        const servers = await Promise.all(
            (await store.listServers()).map(async (server) => {
                const credentials = await store.read(server);
                return {
                    server,
                    authorized: credentials.tokens !== undefined,
                    clientId: credentials.client?.client_id,
                };
            })
        );
        emit({ credentialsFile: store.path, servers }, options);
        return EXIT.OK;
    }

    throw new CliError(
        EXIT.USAGE,
        `Unknown auth subcommand: ${sub}`,
        'Use login, status, logout or list.'
    );
}

/** Login is the one command that may name a server nothing is stored for yet. */
async function resolveServerForLogin(options: GlobalOptions, store: CredentialStore): Promise<string> {
    const explicit = options.server ?? process.env.COURIER_SERVER;
    if (explicit) return explicit.trim();

    const stored = await store.listServers();
    if (stored.length === 1) return stored[0];

    throw new CliError(
        EXIT.USAGE,
        stored.length === 0
            ? 'Which server? Nothing is stored yet, so --server is required.'
            : `More than one server is stored, so --server is required: ${stored.join(', ')}`,
        'Pass --server https://host/mcp, or set COURIER_SERVER.'
    );
}

async function handleTools(options: GlobalOptions): Promise<number> {
    const store = new CredentialStore();
    const serverUrl = await resolveServer(options, store);
    const session = new CourierSession({ serverUrl, store, timeoutMs: options.timeoutMs });

    try {
        const tools = await session.listTools();
        emit(
            tools.map((tool) => ({
                name: tool.name,
                command: tool.name.replace(/_/g, '-'),
                needsYes: requiresConfirmation(tool.name),
                description: tool.description,
                // The full schema, so this is the machine-readable path. `help`
                // is prose for a person and goes to stderr; anything generating
                // calls should read this instead of parsing that.
                inputSchema: tool.inputSchema,
            })),
            options
        );
        return EXIT.OK;
    } finally {
        await session.close();
    }
}

async function handleCall(rawName: string, argv: string[], options: GlobalOptions): Promise<number> {
    if (rawName.startsWith('-')) {
        throw new CliError(EXIT.USAGE, `Unknown option ${rawName}.`, 'Run `courier help` for usage.');
    }

    const toolName = normalizeToolName(rawName);
    const store = new CredentialStore();
    const serverUrl = await resolveServer(options, store);

    // Check the command line against the schema this build ships with, before
    // touching the credential store.
    //
    // Without this, authentication fails first and every mistake reports
    // no-auth: a mistyped flag told an operator to re-authenticate, sending
    // them to inspect a credential that was never the problem. Usage errors are
    // the caller's to fix and must say so, whatever the credential state.
    //
    // Only for a tool this build recognises. An unknown NAME is left to the
    // server, which may be a newer Courier carrying tools this copy has never
    // heard of -- calling those typos would be the CLI asserting what it cannot
    // know.
    const localSchema = await localToolSchema(toolName);
    if (localSchema) {
        validateArguments(argv, describeParameters(localSchema), toolName, options);
    }

    const session = new CourierSession({ serverUrl, store, timeoutMs: options.timeoutMs });

    try {
        // A name this build does not know, on a command that then fails for
        // want of a credential, has two possible explanations and the operator
        // cannot see which. Saying only "run auth login" sends someone to
        // inspect a credential when they have actually mistyped a tool.
        const tools = await session.listTools().catch((error) => {
            throw localSchema ? error : withUnknownNameCaveat(error, toolName);
        });
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) {
            // The server is the authority on what exists. A name this server
            // does not offer might be a typo, might be turned off in Courier's
            // settings, and might be unsupported by the account's credential --
            // all three look identical from here, so say so rather than pick one.
            throw new CliError(
                EXIT.USAGE,
                `${credentialKey(serverUrl)} does not offer a tool named ${toolName}.`,
                'It may be misspelled, turned off in Courier settings, or unsupported by this account. Run `courier tools` to see what is available.'
            );
        }

        // Re-validated against the server's own schema, which is authoritative:
        // the local pass above is an early warning, not the ruling.
        const remoteSchema = tool.inputSchema as JsonSchemaLike;
        const specs = describeParameters(remoteSchema);
        const args = validateArguments(argv, specs, toolName, options);

        // `--all` asks for the largest page the tool offers unless the caller
        // chose a size. The per-call default is tuned for a model paying per
        // token, which is the wrong trade for someone who asked for everything.
        if (options.all && args.limit === undefined && specs.some((spec) => spec.name === 'limit')) {
            args.limit = pageSizeForAll(remoteSchema.properties?.limit as { maximum?: unknown });
        }

        if (requiresConfirmation(toolName) && !options.yes) {
            await confirmOrRefuse(toolName, args, options);
        }

        const payload = await session.callTool(toolName, args);

        if (!options.all) {
            emit(payload, options);
            return EXIT.OK;
        }

        const page = asPage(payload);
        if (!page) {
            // Refusing beats silently ignoring the flag. A caller who asked for
            // every page and got one, with no complaint, has been handed a
            // partial answer that looks complete -- which is the single failure
            // this CLI is built to make impossible.
            throw new CliError(
                EXIT.USAGE,
                `${toolName} does not return paged results, so --all has nothing to walk.`,
                'Drop --all. Paged tools report total, position, returned and hasMore; search_emails is the main one.'
            );
        }

        const complete = await collectAllPages(
            page,
            (position) => session.callTool(toolName, { ...args, position }),
            toolName,
            {
                maxPages: options.maxPages,
                onPage: (fetched, total) => note(options, `  ${fetched}/${total}`),
            }
        );
        emit(complete, options);
        return EXIT.OK;
    } finally {
        await session.close();
    }
}

/**
 * Adds "and this build does not recognise that tool name either" to an
 * authentication failure.
 *
 * Only ever adds context. The server stays authoritative on which tools exist,
 * because this CLI may be talking to a newer Courier -- so this says the name
 * is unrecognised *here*, which is a fact, rather than asserting it is wrong.
 */
function withUnknownNameCaveat(error: unknown, toolName: string): unknown {
    if (!(error instanceof CliError)) return error;
    if (error.code !== EXIT.NO_AUTH && error.code !== EXIT.AUTH_REJECTED) return error;

    return new CliError(
        error.code,
        error.message,
        `${error.hint ? `${error.hint} ` : ''}Note that ${JSON.stringify(toolName)} is not a tool this build knows, so check the spelling too -- a newer server may still have it.`
    );
}

/**
 * Parses and checks a tool's arguments, raising a usage error for anything wrong.
 *
 * Shared between the local pre-flight pass and the authoritative pass against
 * the server's schema, so the two cannot disagree about what counts as valid.
 */
function validateArguments(
    argv: string[],
    specs: ReturnType<typeof describeParameters>,
    toolName: string,
    options: GlobalOptions
): Record<string, unknown> {
    const args = { ...options.argsJson, ...parseToolArgs(argv, specs, toolName) };

    const missing = missingRequired(args, specs);
    if (missing.length > 0) {
        throw new CliError(
            EXIT.USAGE,
            `${toolName} needs ${missing.join(', ')}.`,
            `Run \`courier help ${toolName}\` for the full parameter list.`
        );
    }

    return args;
}

/**
 * Asks before a tool that changes something, or refuses when nobody can answer.
 *
 * Refusing when stdin is not a terminal is the important half. The alternative
 * -- proceeding because no one objected -- means an unattended script sends
 * mail that no human ever approved, and the only trace is in the recipient's
 * inbox. `--yes` is how a script says it has that authority.
 */
async function confirmOrRefuse(
    toolName: string,
    args: Record<string, unknown>,
    options: GlobalOptions
): Promise<void> {
    const reason = confirmationReason(toolName);

    if (!process.stdin.isTTY) {
        throw new CliError(
            EXIT.FORBIDDEN,
            `${toolName} needs confirmation because ${reason}, and this invocation has no terminal to ask at.`,
            'Pass --yes to confirm it in advance.'
        );
    }

    process.stderr.write(`${toolName}: ${reason}.\n`);
    // Argument keys, never values: a draft body or a recipient list does not
    // belong in a terminal log, and the same rule governs the server's tool log.
    process.stderr.write(`Arguments: ${Object.keys(args).sort().join(', ') || 'none'}\n`);

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await new Promise<string>((resolve) => rl.question(`Run ${toolName}? [y/N] `, resolve));
        if (!/^y(es)?$/i.test(answer.trim())) {
            throw new CliError(EXIT.FORBIDDEN, `${toolName} was not confirmed, so nothing ran.`);
        }
    } finally {
        rl.close();
    }
}

async function handleHelp(argv: string[], options: GlobalOptions): Promise<number> {
    const target = argv[0];

    if (!target) {
        process.stderr.write(usage());
        return EXIT.OK;
    }

    const toolName = normalizeToolName(target);

    // Answered from this build's own schemas when it can be. Help is a question
    // about the command line, and demanding a credential to answer it meant a
    // developer with no login was told to authenticate in order to read what a
    // flag is called.
    const localSchema = await localToolSchema(toolName);
    if (localSchema) {
        process.stderr.write(renderToolHelp(toolName, undefined, localSchema));
        return EXIT.OK;
    }

    const store = new CredentialStore();
    const serverUrl = await resolveServer(options, store);
    const session = new CourierSession({ serverUrl, store, timeoutMs: options.timeoutMs });

    try {
        const tools = await session
            .listTools()
            .catch((error) => {
                throw withUnknownNameCaveat(error, toolName);
            });
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) {
            throw new CliError(
                EXIT.USAGE,
                `${credentialKey(serverUrl)} does not offer a tool named ${toolName}.`,
                'Run `courier tools` to see what is available.'
            );
        }

        process.stderr.write(
            renderToolHelp(tool.name, tool.description, tool.inputSchema as JsonSchemaLike)
        );
        return EXIT.OK;
    } finally {
        await session.close();
    }
}

function renderToolHelp(
    name: string,
    description: string | undefined,
    schema: JsonSchemaLike
): string {
    const specs = describeParameters(schema);
    const lines = [`courier ${name.replace(/_/g, '-')} [flags]`, ''];

    if (description) {
        lines.push(wrap(description, 76), '');
    }

    const tier = defaultTierFor(name);
    if (tier !== 'allow') {
        lines.push(`Changes things: ${consequenceOf(name)}.`, 'Needs --yes.', '');
    }

    if (specs.length === 0) {
        lines.push('Takes no parameters.');
    } else {
        lines.push('Flags:');
        for (const spec of specs) {
            const kind = spec.kind === 'array' ? `${spec.itemKind}...` : spec.kind;
            const required = spec.required ? ' (required)' : '';
            const values = spec.enumValues ? ` one of: ${spec.enumValues.join(', ')}` : '';
            lines.push(`  ${spec.flag} <${kind}>${required}`);
            if (spec.description || values) {
                lines.push(wrap(`${spec.description ?? ''}${values}`.trim(), 72, '      '));
            }
        }
    }

    return `${lines.join('\n')}\n`;
}

function usage(): string {
    return `courier ${VERSION} -- mail, calendar, contacts and tasks over JMAP and DAV

Usage:
  courier <tool> [flags]            Call a tool (e.g. courier search-emails --query invoice)
  courier call <tool> [flags]       Same, when a tool name collides with a subcommand
  courier tools                     List the tools this server offers
  courier help <tool>               Show a tool's flags
  courier auth login                Authorize this machine against a Courier server
  courier auth login --remote       Same, when your browser is on another machine
  courier auth login --code <code>  Finish a login started without a terminal
  courier auth status               Show the stored credential for a server
  courier auth logout               Forget a server's credential
  courier auth list                 List servers with stored credentials
  courier exit-codes                Print the exit-code contract as JSON
  courier mcp [--stdio|--http]      Run the Courier server itself

Global flags:
  --server <url>      Courier's MCP endpoint. Defaults to COURIER_SERVER, or to
                      the only stored server when there is exactly one.
  --all               Walk every page of a paged result. All or nothing: if any
                      page fails, nothing is printed and the exit code says
                      incomplete. Never a partial set.
  --max-pages <n>     Page ceiling for --all. Default ${DEFAULT_MAX_PAGES}, which with
                      the largest page size covers most sets in one command.
  --yes, -y           Confirm a tool that changes or sends something.
  --args-json <json>  Base arguments as a JSON object; flags override its keys.
  --timeout <secs>    Per-request timeout. Default 60.
  --pretty/--compact  JSON layout. Defaults to pretty on a terminal.
  --quiet             Suppress progress notes on stderr.
  --remote            Your browser is not on this machine. Courier displays a
                      code to paste back instead of redirecting to a local port.
                      Nothing can detect this reliably, so it is a flag -- but
                      the default recovers without it, see below.
  --no-browser        Print the URL instead of opening a browser.
  --code <code>       Finish a login that had no terminal to paste at.

stdout carries only the result, and only when the exit code is 0. Every
diagnostic goes to stderr. Run \`courier exit-codes\` for what each code means.
`;
}

function wrap(text: string, width: number, indent = '  '): string {
    if (!text) return '';
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        if (current.length + word.length + 1 > width) {
            lines.push(current);
            current = word;
        } else {
            current = current ? `${current} ${word}` : word;
        }
    }
    if (current) lines.push(current);

    return lines.map((line) => `${indent}${line}`).join('\n');
}
