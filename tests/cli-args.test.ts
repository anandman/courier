import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
    describeParameters,
    flagFor,
    missingRequired,
    normalizeToolName,
    parseToolArgs,
    type JsonSchemaLike,
} from '../src/cli/args.js';
import { CliError, EXIT } from '../src/cli/exit.js';
import { searchEmailsSchema } from '../src/tools/search.js';

const schema: JsonSchemaLike = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number' },
        includeBodies: { type: 'boolean' },
        mailboxes: { type: 'array', items: { type: 'string' } },
        filter: { type: 'object' },
        status: { enum: ['open', 'done'] },
    },
    required: ['query'],
};

const specs = describeParameters(schema);

function parse(line: string) {
    return parseToolArgs(line.split(' ').filter(Boolean), specs, 'test_tool');
}

describe('flag naming', () => {
    it('turns camelCase parameters into kebab-case flags', () => {
        expect(flagFor('includeBodies')).toBe('--include-bodies');
        expect(flagFor('query')).toBe('--query');
    });

    it('accepts a tool named with dashes or underscores', () => {
        expect(normalizeToolName('search-emails')).toBe('search_emails');
        expect(normalizeToolName('search_emails')).toBe('search_emails');
    });

    it('also accepts the raw parameter spelling as a flag', () => {
        // A caller reading parameter names out of the JSON schema should not be
        // told that the name the schema uses is wrong.
        expect(parse('--query x --includeBodies')).toEqual({ query: 'x', includeBodies: true });
    });
});

describe('parsing values', () => {
    it('reads a value as the next token or after an equals sign', () => {
        expect(parse('--query hello')).toEqual({ query: 'hello' });
        expect(parse('--query=hello')).toEqual({ query: 'hello' });
    });

    it('coerces numbers and rejects non-numbers', () => {
        expect(parse('--query x --limit 25')).toEqual({ query: 'x', limit: 25 });
        expect(() => parse('--query x --limit twenty')).toThrowError(/takes a number/);
    });

    it('treats a bare boolean flag as true and --no- as false', () => {
        expect(parse('--query x --include-bodies')).toEqual({ query: 'x', includeBodies: true });
        expect(parse('--query x --no-include-bodies')).toEqual({ query: 'x', includeBodies: false });
        expect(parse('--query x --include-bodies=false')).toEqual({ query: 'x', includeBodies: false });
    });

    it('does not let --no- invent a false for a non-boolean', () => {
        // `--no-query` must stay an unknown flag rather than quietly becoming
        // `query: false`, which the server would then reject for the wrong reason.
        expect(() => parse('--no-query')).toThrowError(/no parameter/);
    });

    it('builds an array by repeating the flag', () => {
        expect(parse('--query x --mailboxes Inbox --mailboxes Archive')).toEqual({
            query: 'x',
            mailboxes: ['Inbox', 'Archive'],
        });
    });

    it('accepts a JSON array for an array parameter without nesting it', () => {
        expect(parse('--query x --mailboxes ["a","b"]')).toEqual({ query: 'x', mailboxes: ['a', 'b'] });
    });

    it('wraps a single value for an array parameter', () => {
        expect(parse('--query x --mailboxes Inbox')).toEqual({ query: 'x', mailboxes: ['Inbox'] });
    });

    /**
     * Comma splitting looks helpful until a search query or a subject line
     * contains a comma, at which point it silently changes the question being
     * asked and the caller has no way to see that it happened.
     */
    it('never splits a value on commas', () => {
        expect(parse('--query=Smith,_John')).toEqual({ query: 'Smith,_John' });
        expect(parseToolArgs(['--mailboxes', 'Inbox,Archive'], specs, 't')).toEqual({
            mailboxes: ['Inbox,Archive'],
        });
    });

    it('takes a JSON object for an object parameter and refuses anything else', () => {
        expect(parse('--query x --filter {"a":1}')).toEqual({ query: 'x', filter: { a: 1 } });
        expect(() => parse('--query x --filter nope')).toThrowError(/JSON object/);
    });

    it('reports malformed JSON as a usage error, not as a value', () => {
        try {
            parse('--query x --filter {bad}');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.USAGE);
        }
    });

    it('refuses a repeated flag for a single-valued parameter', () => {
        expect(() => parse('--query a --query b')).toThrowError(/more than once/);
    });

    it('refuses a flag with no value', () => {
        expect(() => parse('--query')).toThrowError(/needs a value/);
    });

    it('refuses a bare positional argument', () => {
        expect(() => parse('search terms')).toThrowError(/needs a flag/);
    });
});

describe('usage errors carry the usage code', () => {
    it('uses exit 2 for everything the caller can fix locally', () => {
        const cases = ['--nope x', '--query', 'bare', '--query a --query b', '--limit abc --query x'];
        for (const line of cases) {
            try {
                parse(line);
                expect.unreachable(`should have thrown for: ${line}`);
            } catch (error) {
                expect((error as CliError).code, line).toBe(EXIT.USAGE);
            }
        }
    });
});

describe('required parameters', () => {
    it('names the flags that are missing', () => {
        expect(missingRequired({}, specs)).toEqual(['--query']);
        expect(missingRequired({ query: 'x' }, specs)).toEqual([]);
    });

    it('lists required parameters first in help order', () => {
        expect(specs[0].name).toBe('query');
        expect(specs[0].required).toBe(true);
    });
});

describe('reading a real tool schema', () => {
    /**
     * The flags come from the server's own schemas, so the derivation has to
     * survive what zod-to-json-schema actually emits -- optional wrappers,
     * coerced numbers, unions and enums -- not a hand-written example.
     */
    const realSpecs = describeParameters(zodToJsonSchema(searchEmailsSchema) as JsonSchemaLike);
    const byName = new Map(realSpecs.map((spec) => [spec.name, spec]));

    it('finds the parameters search_emails actually takes', () => {
        expect(byName.has('query')).toBe(true);
        expect(realSpecs.length).toBeGreaterThan(3);
    });

    it('recognises the numeric paging parameters as numbers', () => {
        for (const name of ['limit', 'position']) {
            const spec = byName.get(name);
            if (!spec) continue;
            expect(spec.kind, name).toBe('number');
        }
    });

    it('carries the schema descriptions into help', () => {
        expect(realSpecs.some((spec) => (spec.description ?? '').length > 0)).toBe(true);
    });
});

describe('shared schemas behind a $ref', () => {
    /**
     * zod-to-json-schema spells out a reused schema once and emits `$ref` for
     * every later use. Courier's recipient union is reused on every send and
     * draft tool, so before refs were resolved `--to` behaved as a list while
     * `--cc` and `--bcc` were uninterpretable -- and addressing two people in
     * CC was rejected as a repeated flag.
     */
    const refSchema: JsonSchemaLike = {
        type: 'object',
        properties: {
            to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
            cc: { anyOf: [{ $ref: '#/properties/to/anyOf/0' }, { $ref: '#/properties/to/anyOf/1' }] },
        },
        required: ['to'],
    };
    const refSpecs = describeParameters(refSchema);
    const byName = new Map(refSpecs.map((spec) => [spec.name, spec]));

    it('resolves a ref to the same kind as the schema it points at', () => {
        expect(byName.get('to')?.kind).toBe('array');
        expect(byName.get('cc')?.kind).toBe('array');
        expect(byName.get('cc')?.itemKind).toBe('string');
    });

    it('lets a refd list parameter be repeated', () => {
        expect(parseToolArgs(['--cc', 'a@example.com', '--cc', 'b@example.com'], refSpecs, 'draft_email')).toEqual({
            cc: ['a@example.com', 'b@example.com'],
        });
    });

    it('does not loop on a self-referential schema', () => {
        const cyclic: JsonSchemaLike = {
            type: 'object',
            properties: { node: { $ref: '#/properties/node' } },
        };
        expect(() => describeParameters(cyclic)).not.toThrow();
    });
});

describe('a string-or-list union', () => {
    const unionSpecs = describeParameters({
        type: 'object',
        properties: {
            to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
    });

    it('accepts one value as a one-element list, which the union permits', () => {
        expect(parseToolArgs(['--to', 'a@example.com'], unionSpecs, 'send_email')).toEqual({
            to: ['a@example.com'],
        });
    });

    it('accepts repetition for several values', () => {
        expect(parseToolArgs(['--to', 'a@example.com', '--to', 'b@example.com'], unionSpecs, 'send_email')).toEqual({
            to: ['a@example.com', 'b@example.com'],
        });
    });
});

describe('every real tool schema yields usable flags', () => {
    /**
     * A parameter of unknown kind is passed through as a raw string, so the
     * server rejects it and the caller is told their value was wrong when the
     * real problem was here. This asserts the whole live tool surface derives
     * cleanly, which is what caught the unresolved $ref in the first place.
     */
    it('leaves no parameter uninterpretable', async () => {
        const { tools } = await import('../src/tools/index.js');
        const uninterpretable: string[] = [];

        for (const tool of tools) {
            for (const spec of describeParameters(zodToJsonSchema(tool.inputSchema) as JsonSchemaLike)) {
                if (spec.kind === 'unknown') uninterpretable.push(`${tool.name}.${spec.name}`);
            }
        }

        expect(uninterpretable).toEqual([]);
    });
});

describe('bounds the schema advertises', () => {
    const bounded = describeParameters({
        type: 'object',
        properties: { limit: { type: 'number', minimum: 1, maximum: 100 } },
    });

    it('reads them off the schema', () => {
        expect(bounded[0].minimum).toBe(1);
        expect(bounded[0].maximum).toBe(100);
    });

    /**
     * The server refuses an over-large page too, and correctly -- but its
     * refusal arrives as a validation dump inside a tool error, which reads as
     * a server fault for what is plainly a bad argument.
     */
    it('refuses a value above the maximum as a usage error', () => {
        try {
            parseToolArgs(['--limit', '5000'], bounded, 'search_emails');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as CliError).code).toBe(EXIT.USAGE);
            expect((error as CliError).message).toMatch(/at most 100/);
            expect((error as CliError).hint).toMatch(/--all/);
        }
    });

    it('refuses a value below the minimum', () => {
        expect(() => parseToolArgs(['--limit', '0'], bounded, 'search_emails')).toThrowError(/at least 1/);
    });

    it('accepts the bounds themselves', () => {
        expect(parseToolArgs(['--limit', '100'], bounded, 'search_emails')).toEqual({ limit: 100 });
        expect(parseToolArgs(['--limit', '1'], bounded, 'search_emails')).toEqual({ limit: 1 });
    });
});
