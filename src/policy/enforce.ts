/**
 * The enforcement point: whether this client may run this tool, right now.
 *
 * Enforced at `tools/call` and nowhere else. Every tool stays advertised in
 * `tools/list`, including denied ones, because changing the advertised set is
 * not free: clients cache it, and several of them only pick up a change when
 * the server is removed and re-added by hand. A tool that appears and refuses
 * is a bad turn; a tool that vanishes can cost a reinstall.
 */

import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { consequenceOf, tierFor, type Tier } from './tiers.js';

export interface EnforcementRequest {
    toolName: string;
    args: unknown;
    overrides?: Record<string, Tier>;
    /** Sends an elicitation request to the client, if it can receive one. */
    elicit?: (message: string) => Promise<unknown>;
    /** Whether the connected client declared the elicitation capability. */
    canElicit: boolean;
}

export type EnforcementOutcome =
    | { allowed: true; confirmed?: boolean }
    | { allowed: false; reason: string };

/**
 * A sentence describing what is about to happen, for the confirmation prompt.
 *
 * Argument KEYS only, never values. A draft body, a recipient list and a search
 * query are all arguments, and this text is rendered by the client and may well
 * be logged by it. The server's own tool log follows the same rule one level
 * up.
 */
export function describeCall(toolName: string, args: unknown): string {
    const keys = args && typeof args === 'object' ? Object.keys(args as object).sort() : [];
    const parameters = keys.length > 0 ? ` (parameters: ${keys.join(', ')})` : '';
    return `Allow ${toolName}? It ${consequenceOf(toolName)}${parameters}.`;
}

export async function enforce(request: EnforcementRequest): Promise<EnforcementOutcome> {
    const tier = tierFor(request.toolName, request.overrides);

    if (tier === 'allow') return { allowed: true };

    if (tier === 'deny') {
        return {
            allowed: false,
            reason:
                `${request.toolName} is not permitted for this client. It ${consequenceOf(request.toolName)}, ` +
                'and this client has not been granted it. Change that in Courier settings if you intend to allow it.',
        };
    }

    // confirm.
    //
    // A client that cannot ask a human is refused rather than allowed. The
    // whole purpose of this tier is that a person sees the action first, and
    // treating "nobody could be asked" as consent would quietly convert every
    // confirm into an allow for exactly the unattended clients the tier exists
    // to constrain.
    //
    // Worth knowing how often this branch is taken today: over the stateless
    // HTTP transport it is taken ALWAYS. A fresh Server is built per request,
    // so the capabilities declared during `initialize` belong to a different
    // instance and `getClientCapabilities()` is always undefined -- and even
    // with the capability known, the client's reply to a server-initiated
    // request would arrive at yet another instance with no pending request to
    // resolve. Elicitation needs a session. Until the transport has one,
    // `confirm` behaves as "refused unless you grant this client the tool",
    // which is safe but is not what the name promises.
    if (!request.canElicit || !request.elicit) {
        return {
            allowed: false,
            reason:
                `${request.toolName} needs confirmation because it ${consequenceOf(request.toolName)}, ` +
                'and this client cannot ask you: it did not offer the MCP elicitation capability. ' +
                'Set this tool to "allow" for this client in Courier settings if you want it to run unattended.',
        };
    }

    let result: unknown;
    try {
        result = await request.elicit(describeCall(request.toolName, request.args));
    } catch (error) {
        // A failed prompt is not a yes. This covers a client that declared the
        // capability and then errored, and a request that timed out.
        const message = error instanceof Error ? error.message : String(error);
        return {
            allowed: false,
            reason: `${request.toolName} was not run: asking you to confirm it failed (${message}).`,
        };
    }

    const parsed = ElicitResultSchema.safeParse(result);
    if (!parsed.success) {
        return {
            allowed: false,
            reason: `${request.toolName} was not run: the confirmation response could not be understood.`,
        };
    }

    if (parsed.data.action !== 'accept') {
        // decline and cancel are both "not yes", and the difference does not
        // change what happens -- but it changes what to say, since one is a
        // decision and the other is a dismissal.
        return {
            allowed: false,
            reason:
                parsed.data.action === 'decline'
                    ? `${request.toolName} was declined, so nothing ran.`
                    : `${request.toolName} was not confirmed, so nothing ran.`,
        };
    }

    return { allowed: true, confirmed: true };
}
