import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../src/cli/exit.js';
import { run } from '../src/cli/main.js';
import { handleStatelessMcpRequest } from '../src/http-transport.js';

/**
 * The CLI against a real Courier, over real MCP.
 *
 * Mocked units cannot establish the property that matters here, which is about
 * the process as a whole: that a non-zero exit writes nothing to stdout. A
 * consumer piping stdout into a cache depends on that being true of the binary,
 * not of a function.
 */
let httpServer: HttpServer | undefined;
let endpoint: string;
let dir: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.all('/mcp', handleStatelessMcpRequest);

    httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
        httpServer?.once('error', reject);
        httpServer?.listen(0, '127.0.0.1', resolve);
    });

    const address = httpServer.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
    if (httpServer?.listening) {
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
});

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'courier-e2e-'));
    process.env.COURIER_CLI_FILE = join(dir, 'cli-credentials.json');
    process.env.COURIER_SERVER = endpoint;
    return async () => {
        delete process.env.COURIER_CLI_FILE;
        delete process.env.COURIER_SERVER;
        await rm(dir, { recursive: true, force: true });
    };
});

interface Invocation {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs the CLI in-process, capturing exactly what each stream received. */
async function courier(...argv: string[]): Promise<Invocation> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);

    process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout.push(chunk.toString());
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr.push(chunk.toString());
        return true;
    }) as typeof process.stderr.write;

    try {
        const code = await run(argv).catch((error) => {
            // bin.ts reports the failure and sets the code; mirror that here so
            // the test observes what a shell would.
            const cliError = error as { code?: number; message?: string; hint?: string };
            stderr.push(`courier: ${cliError.message}\n`);
            if (cliError.hint) stderr.push(`${cliError.hint}\n`);
            return typeof cliError.code === 'number' ? cliError.code : EXIT.INTERNAL;
        });
        return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
    }
}

describe('listing what a server offers', () => {
    it('lists tools as JSON on stdout', async () => {
        const result = await courier('tools', '--compact');

        expect(result.code).toBe(EXIT.OK);
        const tools = JSON.parse(result.stdout) as { name: string; needsYes: boolean }[];
        expect(tools.map((tool) => tool.name)).toContain('search_emails');
        expect(tools.find((tool) => tool.name === 'search_emails')?.needsYes).toBe(false);
        expect(tools.find((tool) => tool.name === 'send_email')?.needsYes).toBe(true);
    });

    it('offers each tool under a dashed command name', async () => {
        const result = await courier('tools', '--compact');
        const tools = JSON.parse(result.stdout) as { name: string; command: string }[];

        expect(tools.find((tool) => tool.name === 'search_emails')?.command).toBe('search-emails');
    });
});

describe('calling a tool', () => {
    it('prints the result and exits zero', async () => {
        const result = await courier('list-accounts', '--compact');

        expect(result.code).toBe(EXIT.OK);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('accepts the underscored tool name too', async () => {
        expect((await courier('list_accounts', '--compact')).code).toBe(EXIT.OK);
    });

    it('reports a tool failure as tool-error and prints no data', async () => {
        // The server answers, and the answer is that the operation failed. That
        // arrives as isError on an otherwise successful JSON-RPC response --
        // the shape a client that only unwraps content[].text reads as an
        // empty result.
        const result = await courier('switch-account', '--account', 'definitely-not-a-configured-account');

        expect(result.code).toBe(EXIT.TOOL_ERROR);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('courier:');
    });
});

describe('the contract that stdout carries only answers', () => {
    /**
     * Every failure the CLI can reach locally, checked for the same thing: a
     * non-zero exit and an empty stdout. This is the invariant a consumer
     * relies on when it pipes stdout into a cache.
     */
    it('writes nothing to stdout on any failure', async () => {
        const failures: [string, string[]][] = [
            ['unknown tool', ['no-such-tool-at-all']],
            ['unknown flag', ['search-emails', '--nonsense', 'x']],
            ['bad number', ['search-emails', '--limit', 'twenty']],
            ['missing value', ['search-emails', '--query']],
            ['positional argument', ['search-emails', 'invoices']],
            ['missing required', ['get-email']],
            ['unconfirmed write', ['send-email', '--to', 'a@example.com', '--subject', 's', '--body', 'b']],
            ['bad auth subcommand', ['auth', 'frobnicate']],
        ];

        for (const [label, argv] of failures) {
            const result = await courier(...argv);
            expect(result.code, label).not.toBe(EXIT.OK);
            expect(result.stdout, label).toBe('');
        }
    });

    it('classifies each of those failures', async () => {
        expect((await courier('no-such-tool-at-all')).code).toBe(EXIT.USAGE);
        expect((await courier('search-emails', '--nonsense', 'x')).code).toBe(EXIT.USAGE);
        expect((await courier('search-emails', '--limit', 'twenty')).code).toBe(EXIT.USAGE);
        expect((await courier('get-email')).code).toBe(EXIT.USAGE);
        expect((await courier('auth', 'frobnicate')).code).toBe(EXIT.USAGE);
    });
});

describe('the confirmation gate', () => {
    /**
     * stdin is not a terminal under the test runner, which is exactly the
     * situation this gate exists for: an unattended invocation of a tool that
     * sends mail must refuse rather than proceed because nobody objected.
     */
    it('refuses to send without --yes when there is no terminal', async () => {
        const result = await courier('send-email', '--to', 'a@example.com', '--subject', 's', '--body', 'b');

        expect(result.code).toBe(EXIT.FORBIDDEN);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/--yes/);
    });

    it('explains that sending cannot be undone', async () => {
        const result = await courier('send-email', '--to', 'a@example.com', '--subject', 's', '--body', 'b');
        expect(result.stderr).toMatch(/cannot be undone/);
    });

    it('does not gate a read', async () => {
        // Reaching the server at all proves the gate let it past; what the tool
        // then returns depends on the account configuration, not on the gate.
        const result = await courier('list-accounts', '--compact');
        expect(result.code).toBe(EXIT.OK);
    });

    it('still refuses a gated tool whose arguments are invalid, without sending', async () => {
        const result = await courier('send-email', '--to', 'a@example.com');
        // Usage is checked before the gate, so the caller learns the command is
        // wrong rather than being asked to confirm something that cannot run.
        expect(result.code).toBe(EXIT.USAGE);
        expect(result.stdout).toBe('');
    });
});

describe('asking for every page', () => {
    it('refuses --all on a tool that does not page', async () => {
        // Ignoring the flag would hand back one page in answer to a request for
        // all of them, with nothing to say so.
        const result = await courier('list-accounts', '--all');

        expect(result.code).toBe(EXIT.USAGE);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/does not return paged results/);
    });

    it('rejects a nonsensical page ceiling', async () => {
        expect((await courier('search-emails', '--all', '--max-pages', '0')).code).toBe(EXIT.USAGE);
        expect((await courier('search-emails', '--all', '--max-pages', 'lots')).code).toBe(EXIT.USAGE);
    });
});

describe('help and the contract itself', () => {
    it('prints usage on stderr, keeping stdout clean', async () => {
        const result = await courier();

        expect(result.code).toBe(EXIT.OK);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('courier auth login');
    });

    it('describes a tool from the server schema', async () => {
        const result = await courier('help', 'search-emails');

        expect(result.code).toBe(EXIT.OK);
        expect(result.stderr).toContain('--query');
        expect(result.stderr).toContain('--position');
    });

    it('says which tools need --yes in their help', async () => {
        const result = await courier('help', 'send-email');
        expect(result.stderr).toMatch(/Needs --yes/);
    });

    it('publishes the exit-code table as JSON', async () => {
        const result = await courier('exit-codes', '--compact');

        expect(result.code).toBe(EXIT.OK);
        const table = JSON.parse(result.stdout) as { code: number; name: string; emitted: boolean }[];
        expect(table.find((entry) => entry.code === 0)?.name).toBe('ok');
        // Every published code is emitted now. upstream-auth was reserved
        // while the server had no way to say "the provider refused our
        // credential" apart from prose; it is carried by a structured
        // errorCode, so a consumer can act on it.
        expect(table.every((entry) => entry.emitted)).toBe(true);
    });
});

describe('talking to a server that is not there', () => {
    it('reports an unreachable server as retriable, not as an empty answer', async () => {
        // Port 1 is reserved and nothing listens on it.
        const result = await courier('list-accounts', '--server', 'http://127.0.0.1:1/mcp');

        expect(result.code).toBe(EXIT.UNREACHABLE);
        expect(result.stdout).toBe('');
    });

    it('refuses a remote server with no stored credentials before registering one', async () => {
        const result = await courier('list-accounts', '--server', 'https://courier.invalid/mcp');

        expect(result.code).toBe(EXIT.NO_AUTH);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/auth login/);
    });
});

describe('choosing a server', () => {
    it('refuses to guess when none is given and none is stored', async () => {
        delete process.env.COURIER_SERVER;
        const result = await courier('list-accounts');

        expect(result.code).toBe(EXIT.USAGE);
        expect(result.stderr).toMatch(/--server/);
    });

    it('reports no stored credential as no-auth rather than as a usable status', async () => {
        const result = await courier('auth', 'status');

        expect(result.code).toBe(EXIT.NO_AUTH);
        expect(result.stdout).toBe('');
    });

    it('treats logout as idempotent', async () => {
        const result = await courier('auth', 'logout', '--compact');

        expect(result.code).toBe(EXIT.OK);
        expect(JSON.parse(result.stdout)).toMatchObject({ forgotten: false });
    });
});

describe('a bad command line is reported as a bad command line', () => {
    /**
     * Found by a consumer session testing the contract: authentication was
     * checked before argv was parsed, so every mistake reported no-auth. A
     * mistyped flag told an operator to re-authenticate, sending them to
     * inspect a credential that was never the problem. Exit 2 was documented
     * and unreachable.
     */
    const noCredentials = async (...argv: string[]) => {
        const previous = process.env.COURIER_CLI_FILE;
        process.env.COURIER_CLI_FILE = join(dir, 'nothing-here.json');
        try {
            return await courier(...argv);
        } finally {
            if (previous === undefined) delete process.env.COURIER_CLI_FILE;
            else process.env.COURIER_CLI_FILE = previous;
        }
    };

    it('reports a bad flag value before asking for a credential', async () => {
        const result = await noCredentials('search-emails', '--limit', 'notanumber', '--server', 'https://nowhere.invalid/mcp');

        expect(result.code).toBe(EXIT.USAGE);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/takes a number/);
    });

    it('reports an unknown flag, a stray positional and a missing required the same way', async () => {
        const cases: [string, string[]][] = [
            ['unknown flag', ['search-emails', '--nonsense', 'x']],
            ['positional', ['search-emails', 'invoices']],
            ['missing required', ['get-email']],
        ];

        for (const [label, argv] of cases) {
            const result = await noCredentials(...argv, '--server', 'https://nowhere.invalid/mcp');
            expect(result.code, label).toBe(EXIT.USAGE);
            expect(result.stdout, label).toBe('');
        }
    });

    it('answers help without a credential at all', async () => {
        // Help is a question about the command line. Demanding a credential to
        // answer it told a developer with no login to authenticate in order to
        // read what a flag is called.
        const result = await noCredentials('help', 'search-emails', '--server', 'https://nowhere.invalid/mcp');

        expect(result.code).toBe(EXIT.OK);
        expect(result.stderr).toContain('--query');
    });

    /**
     * An unrecognised NAME still defers to the server: this build may be
     * talking to a newer Courier carrying tools it has never heard of, and
     * calling those typos would be asserting what it cannot know. But the
     * message must not send the operator to the wrong place.
     */
    it('still needs a credential for an unknown name, and says the name is unknown too', async () => {
        const result = await noCredentials('definitely-not-a-tool', '--server', 'https://nowhere.invalid/mcp');

        expect(result.code).toBe(EXIT.NO_AUTH);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/not a tool this build knows/);
        expect(result.stderr).toMatch(/newer server may still have it/);
    });

    it('does not add that caveat for a tool it does know', async () => {
        const result = await noCredentials('search-emails', '--query', 'x', '--server', 'https://nowhere.invalid/mcp');

        expect(result.code).toBe(EXIT.NO_AUTH);
        expect(result.stderr).not.toMatch(/not a tool this build knows/);
    });
});
