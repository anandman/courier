/**
 * The tool schemas this CLI was built with.
 *
 * The CLI ships inside the same package as the server, so it already knows what
 * every tool takes. That knowledge is used for one thing only: catching a bad
 * command line before spending a network round trip, and before a missing
 * credential masks the real problem.
 *
 * The server stays authoritative. A name this build does not recognise is NOT
 * treated as a typo -- the CLI may be talking to a newer Courier that has tools
 * this copy has never heard of, and rejecting those would be the CLI asserting
 * something it cannot know. Local knowledge can only ever produce an error for
 * a tool it does recognise, where it is describing its own package.
 *
 * Loaded on demand. Importing the tool registry pulls in the whole server
 * stack, which is pure at module scope but not free, and most invocations
 * never need it.
 */

import type { JsonSchemaLike } from './args.js';

let registry: Map<string, JsonSchemaLike> | null = null;

async function load(): Promise<Map<string, JsonSchemaLike>> {
    if (registry) return registry;

    const [{ tools }, { zodToJsonSchema }] = await Promise.all([
        import('../tools/index.js'),
        import('zod-to-json-schema'),
    ]);

    registry = new Map(
        tools.map((tool) => [tool.name, zodToJsonSchema(tool.inputSchema) as JsonSchemaLike])
    );
    return registry;
}

/**
 * The schema for a tool, or undefined when this build does not know it.
 *
 * Undefined means "no opinion", never "no such tool".
 */
export async function localToolSchema(toolName: string): Promise<JsonSchemaLike | undefined> {
    try {
        return (await load()).get(toolName);
    } catch {
        // A registry that fails to load must not fail the command: everything
        // it offers is an optimisation over asking the server.
        return undefined;
    }
}

/** Tool names this build knows, for describing what a mistyped name might have meant. */
export async function localToolNames(): Promise<string[]> {
    try {
        return [...(await load()).keys()].sort();
    } catch {
        return [];
    }
}
