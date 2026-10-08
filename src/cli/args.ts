/**
 * Flags in, tool arguments out.
 *
 * The flag set for every subcommand comes from the server's own `tools/list`
 * schemas rather than from a table kept here. A CLI that hardcoded its flags
 * would drift from the server the first time a tool gained a parameter, and
 * would then reject valid input while claiming the input was wrong -- the
 * caller's fault for a problem entirely on this side.
 */

import { CliError, EXIT } from './exit.js';

export interface JsonSchemaLike {
    minimum?: number;
    maximum?: number;
    $ref?: string;
    definitions?: Record<string, JsonSchemaLike>;
    $defs?: Record<string, JsonSchemaLike>;
    type?: string | string[];
    properties?: Record<string, JsonSchemaLike>;
    required?: string[];
    items?: JsonSchemaLike;
    enum?: unknown[];
    anyOf?: JsonSchemaLike[];
    oneOf?: JsonSchemaLike[];
    allOf?: JsonSchemaLike[];
    default?: unknown;
    description?: string;
}

export type ParamKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

export interface ParamSpec {
    name: string;
    flag: string;
    kind: ParamKind;
    itemKind: ParamKind;
    required: boolean;
    enumValues?: unknown[];
    description?: string;
    /** Bounds the schema advertises, enforced here so a breach is a usage error. */
    minimum?: number;
    maximum?: number;
}

/** `search_emails` and `search-emails` are the same tool; both spellings are accepted. */
export function normalizeToolName(name: string): string {
    return name.trim().replace(/-/g, '_');
}

export function flagFor(paramName: string): string {
    // camelCase to kebab-case, because every other flag on a terminal is
    // kebab-case and `--includeBodies` reads like a mistake.
    return `--${paramName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

export function describeParameters(schema: JsonSchemaLike | undefined): ParamSpec[] {
    const root = schema ? (inlineRefs(schema, schema, 0) as JsonSchemaLike) : undefined;
    const properties = root?.properties ?? {};
    const required = new Set(root?.required ?? []);

    return Object.entries(properties)
        .map(([name, property]) => ({
            name,
            flag: flagFor(name),
            ...classify(property),
            required: required.has(name),
            enumValues: collectEnum(property),
            description: property.description,
            minimum: typeof property.minimum === 'number' ? property.minimum : undefined,
            maximum: typeof property.maximum === 'number' ? property.maximum : undefined,
        }))
        .sort((a, b) => {
            if (a.required !== b.required) return a.required ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
}

export interface ParsedArgs {
    args: Record<string, unknown>;
    /** Flags consumed from the front of the list that belong to the CLI, not the tool. */
    rest: string[];
}

/**
 * Turns `--query foo --limit 10 --mailbox a --mailbox b` into an argument object.
 *
 * Repeated flags build an array; nothing is comma-split. Splitting on commas
 * would be convenient right up until a search query or a subject line contains
 * one, at which point it silently changes the question being asked.
 */
export function parseToolArgs(argv: string[], specs: ParamSpec[], toolName: string): Record<string, unknown> {
    const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
    // Accept the underscored spelling too, so a caller copying a parameter name
    // out of the tool's JSON schema is not told it is wrong.
    for (const spec of specs) {
        byFlag.set(`--${spec.name}`, spec);
    }

    const collected = new Map<string, unknown[]>();
    let index = 0;

    while (index < argv.length) {
        const token = argv[index];

        if (token === '--') {
            index += 1;
            continue;
        }

        if (!token.startsWith('--')) {
            throw new CliError(
                EXIT.USAGE,
                `Unexpected argument ${JSON.stringify(token)} for ${toolName}; every value needs a flag.`,
                `Run \`courier help ${toolName}\` to see the flags this tool takes.`
            );
        }

        const equals = token.indexOf('=');
        const rawFlag = equals === -1 ? token : token.slice(0, equals);
        const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

        // `--no-foo` sets a boolean false. Only honoured for parameters that
        // actually are booleans, so `--no-query` stays an unknown flag rather
        // than quietly becoming `query: false`.
        const negated = rawFlag.startsWith('--no-') ? byFlag.get(`--${rawFlag.slice(5)}`) : undefined;
        if (negated && negated.kind === 'boolean' && inlineValue === undefined) {
            push(collected, negated.name, false);
            index += 1;
            continue;
        }

        const spec = byFlag.get(rawFlag);
        if (!spec) {
            throw new CliError(
                EXIT.USAGE,
                `${toolName} has no parameter ${rawFlag}.`,
                `Run \`courier help ${toolName}\` to see the flags this tool takes.`
            );
        }

        if (spec.kind === 'boolean' && inlineValue === undefined) {
            push(collected, spec.name, true);
            index += 1;
            continue;
        }

        const value = inlineValue ?? argv[index + 1];
        if (value === undefined) {
            throw new CliError(EXIT.USAGE, `${rawFlag} needs a value.`);
        }
        index += inlineValue === undefined ? 2 : 1;

        push(collected, spec.name, coerce(value, spec));
    }

    const args: Record<string, unknown> = {};
    for (const [name, values] of collected) {
        const spec = specs.find((candidate) => candidate.name === name);
        if (spec?.kind === 'array') {
            // A single JSON array given for an array parameter is the array,
            // not an array containing it.
            args[name] = values.length === 1 && Array.isArray(values[0]) ? values[0] : values.flat();
        } else if (values.length > 1) {
            throw new CliError(EXIT.USAGE, `${flagFor(name)} was given more than once but takes a single value.`);
        } else {
            args[name] = values[0];
        }
    }

    return args;
}

/** Required parameters the caller left out. Checked here so the error says which. */
export function missingRequired(args: Record<string, unknown>, specs: ParamSpec[]): string[] {
    return specs
        .filter((spec) => spec.required && args[spec.name] === undefined)
        .map((spec) => spec.flag);
}

function coerce(raw: string, spec: ParamSpec): unknown {
    const kind = spec.kind === 'array' ? spec.itemKind : spec.kind;

    if (spec.kind === 'array' || spec.kind === 'object' || kind === 'object') {
        // A JSON value is the only unambiguous way to express structure on a
        // command line, so accept it wherever structure is expected -- but only
        // when it looks like JSON, so a plain string value still works for an
        // array of strings.
        const trimmed = raw.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                return JSON.parse(trimmed);
            } catch (error) {
                throw new CliError(
                    EXIT.USAGE,
                    `${spec.flag} looks like JSON but does not parse: ${(error as Error).message}`
                );
            }
        }
        if (spec.kind === 'object') {
            throw new CliError(EXIT.USAGE, `${spec.flag} takes a JSON object.`);
        }
    }

    if (kind === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            throw new CliError(EXIT.USAGE, `${spec.flag} takes a number; got ${JSON.stringify(raw)}.`);
        }
        // Bounds the schema declares are checked here rather than left to the
        // server. The server's refusal is correct but arrives as a validation
        // dump inside a tool error, which reads as a server fault for what is
        // plainly a bad argument.
        if (spec.maximum !== undefined && parsed > spec.maximum) {
            throw new CliError(
                EXIT.USAGE,
                `${spec.flag} takes at most ${spec.maximum}; got ${parsed}.`,
                spec.name === 'limit' ? 'Page with --position, or use --all to walk the whole set.' : undefined
            );
        }
        if (spec.minimum !== undefined && parsed < spec.minimum) {
            throw new CliError(
                EXIT.USAGE,
                `${spec.flag} takes at least ${spec.minimum}; got ${parsed}.`
            );
        }
        return parsed;
    }

    if (kind === 'boolean') {
        const lowered = raw.trim().toLowerCase();
        if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
        if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
        throw new CliError(EXIT.USAGE, `${spec.flag} takes true or false; got ${JSON.stringify(raw)}.`);
    }

    return raw;
}

function push(collected: Map<string, unknown[]>, name: string, value: unknown): void {
    const existing = collected.get(name);
    if (existing) {
        existing.push(value);
    } else {
        collected.set(name, [value]);
    }
}

/**
 * A parameter's kind, and its element kind when it is a list.
 *
 * Unions get special treatment because Courier uses one everywhere recipients
 * appear: `string | string[]`, where the server normalises both to a list. A
 * union with an array branch is therefore treated as a list, which is what
 * makes `--to a@example.com --to b@example.com` work. Without it, repeating the
 * flag is rejected as "given more than once" and the only way to address two
 * people is to hand-write JSON -- for the most common multi-value parameter in
 * the whole tool surface.
 */
export function classify(schema: JsonSchemaLike | undefined): { kind: ParamKind; itemKind: ParamKind } {
    if (!schema) return { kind: 'unknown', itemKind: 'unknown' };

    const direct = kindOf(schema);
    if (direct === 'array') {
        return { kind: 'array', itemKind: kindOf(schema.items) };
    }
    if (direct !== 'unknown') {
        return { kind: direct, itemKind: 'unknown' };
    }

    const branches = schema.anyOf ?? schema.oneOf ?? schema.allOf ?? [];
    const arrayBranch = branches.find((branch) => kindOf(branch) === 'array');
    if (arrayBranch) {
        return { kind: 'array', itemKind: kindOf(arrayBranch.items) };
    }

    return { kind: 'unknown', itemKind: 'unknown' };
}

/**
 * Replaces `$ref` pointers with what they point at.
 *
 * zod-to-json-schema emits a ref whenever two parameters share a schema, which
 * Courier's tools do constantly -- every recipient field on every send and
 * draft tool is the same `string | string[]` union, so only the first one is
 * spelled out and the rest are refs into it. Without resolving them, `--to`
 * became a list while `--cc` and `--bcc` stayed uninterpretable, and passing
 * two CC addresses was rejected as a repeated flag.
 *
 * Depth-limited rather than cycle-tracked: a recursive schema resolves to an
 * empty object at the limit, which reads as an unknown kind and is passed
 * through as a string for the server to judge. Guessing deeper would be worse
 * than deferring.
 */
function inlineRefs(node: unknown, root: JsonSchemaLike, depth: number): unknown {
    if (depth > 8 || node === null || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
        return node.map((entry) => inlineRefs(entry, root, depth + 1));
    }

    const schema = node as JsonSchemaLike & Record<string, unknown>;
    if (typeof schema.$ref === 'string') {
        const target = resolvePointer(root, schema.$ref);
        if (!target) return {};
        const { $ref: _ignored, ...rest } = schema;
        return { ...(inlineRefs(target, root, depth + 1) as object), ...rest };
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        result[key] = inlineRefs(value, root, depth + 1);
    }
    return result;
}

/** Resolves a local JSON pointer such as `#/properties/to/anyOf/0`. */
function resolvePointer(root: JsonSchemaLike, ref: string): JsonSchemaLike | undefined {
    if (!ref.startsWith('#/')) return undefined;

    let current: unknown = root;
    for (const rawSegment of ref.slice(2).split('/')) {
        if (current === null || typeof current !== 'object') return undefined;
        const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
        current = Array.isArray(current)
            ? current[Number.parseInt(segment, 10)]
            : (current as Record<string, unknown>)[segment];
    }

    return current && typeof current === 'object' ? (current as JsonSchemaLike) : undefined;
}

function kindOf(schema: JsonSchemaLike | undefined): ParamKind {
    if (!schema) return 'unknown';

    const declared = Array.isArray(schema.type)
        ? schema.type.find((entry) => entry !== 'null')
        : schema.type;

    switch (declared) {
        case 'string':
            return 'string';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'array':
            return 'array';
        case 'object':
            return 'object';
        default:
            break;
    }

    if (schema.enum && schema.enum.length > 0) {
        return schema.enum.every((entry) => typeof entry === 'string') ? 'string' : 'unknown';
    }

    // Unions come out of zod-to-json-schema as anyOf/oneOf. A union of one
    // concrete type is that type; a genuinely mixed union stays unknown and is
    // passed through as a string, which the server's own schema then judges.
    const branches = schema.anyOf ?? schema.oneOf ?? schema.allOf;
    if (branches && branches.length > 0) {
        const kinds = new Set(branches.map((branch) => kindOf(branch)).filter((kind) => kind !== 'unknown'));
        if (kinds.size === 1) return [...kinds][0];
    }

    return 'unknown';
}

function collectEnum(schema: JsonSchemaLike): unknown[] | undefined {
    if (schema.enum && schema.enum.length > 0) return schema.enum;
    const branches = schema.anyOf ?? schema.oneOf;
    const values = branches?.flatMap((branch) => branch.enum ?? []);
    return values && values.length > 0 ? values : undefined;
}
