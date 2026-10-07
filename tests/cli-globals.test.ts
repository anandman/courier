import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { describeParameters, type JsonSchemaLike } from '../src/cli/args.js';
import { CliError, EXIT } from '../src/cli/exit.js';
import { GLOBAL_FLAGS, extractGlobals } from '../src/cli/main.js';
import { tools } from '../src/tools/index.js';

describe('global flags', () => {
    it('reads them before the subcommand', () => {
        const { options, rest } = extractGlobals(['--server', 'https://host/mcp', 'search-emails', '--query', 'x']);

        expect(options.server).toBe('https://host/mcp');
        expect(rest).toEqual(['search-emails', '--query', 'x']);
    });

    it('reads them after the subcommand too', () => {
        // Making the user remember which half of the line a flag belongs to is
        // a tax with no return.
        const { options, rest } = extractGlobals(['search-emails', '--query', 'x', '--server=https://host/mcp']);

        expect(options.server).toBe('https://host/mcp');
        expect(rest).toEqual(['search-emails', '--query', 'x']);
    });

    it('takes a timeout in seconds', () => {
        expect(extractGlobals(['--timeout', '5']).options.timeoutMs).toBe(5000);
        expect(() => extractGlobals(['--timeout', 'soon'])).toThrowError(/positive number/);
        expect(() => extractGlobals(['--timeout', '0'])).toThrowError(/positive number/);
    });

    it('defaults confirmation to off', () => {
        expect(extractGlobals([]).options.yes).toBe(false);
        expect(extractGlobals(['--yes']).options.yes).toBe(true);
        expect(extractGlobals(['-y']).options.yes).toBe(true);
    });

    it('takes base arguments as JSON and rejects anything that is not an object', () => {
        expect(extractGlobals(['--args-json', '{"a":1}']).options.argsJson).toEqual({ a: 1 });
        expect(() => extractGlobals(['--args-json', '[1]'])).toThrowError(/JSON object/);
        expect(() => extractGlobals(['--args-json', 'nope'])).toThrowError(/does not parse/);
    });

    it('reports a missing value as a usage error', () => {
        try {
            extractGlobals(['--server']);
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.USAGE);
        }
    });

    it('leaves unknown flags for the tool to interpret', () => {
        // A flag this file does not recognise belongs to the tool, and must
        // reach it unchanged -- including one that merely looks global.
        expect(extractGlobals(['search-emails', '--query', '--server-ish']).rest).toEqual([
            'search-emails',
            '--query',
            '--server-ish',
        ]);
    });
});

/**
 * The CLI's own flags are stripped from anywhere on the line, which only works
 * while no tool has a parameter of the same name. If one ever does, that
 * parameter becomes unreachable and the global silently swallows its value --
 * a flag that looks accepted and does nothing.
 */
describe('global flags cannot shadow a tool parameter', () => {
    it('collides with nothing in the live tool surface', () => {
        const collisions: string[] = [];

        for (const tool of tools) {
            for (const spec of describeParameters(zodToJsonSchema(tool.inputSchema) as JsonSchemaLike)) {
                if (GLOBAL_FLAGS.has(spec.flag) || GLOBAL_FLAGS.has(`--${spec.name}`)) {
                    collisions.push(`${tool.name} ${spec.flag}`);
                }
            }
        }

        expect(collisions).toEqual([]);
    });

    it('lists the globals it is protecting', () => {
        // Spelled out so adding a global without checking for a collision
        // fails this file rather than a user's command.
        expect([...GLOBAL_FLAGS].sort()).toEqual([
            '--all',
            '--args-json',
            '--code',
            '--compact',
            '--max-pages',
            '--no-browser',
            '--pretty',
            '--quiet',
            '--remote',
            '--server',
            '--timeout',
            '--yes',
            '-y',
        ]);
    });
});
