/**
 * Where tool enforcement finds a client's permissions.
 *
 * A module-level registration rather than a constructor argument, because the
 * MCP server is rebuilt per request in stateless HTTP mode and the transport
 * that rebuilds it has no reason to know about OAuth clients. The same shape
 * the account manager already uses.
 *
 * Nothing registers a provider in stdio mode, and that is deliberate -- see
 * `resolvePolicy` for why.
 */

import type { Tier } from './tiers.js';

export interface PolicyProvider {
    /**
     * The tiers deliberately set for a client. `undefined` means the client is
     * not known, which is a different answer from "known, no overrides".
     */
    policyFor(clientId: string): Promise<Record<string, Tier> | undefined>;
}

let provider: PolicyProvider | null = null;

export function setPolicyProvider(next: PolicyProvider | null): void {
    provider = next;
}

export function getPolicyProvider(): PolicyProvider | null {
    return provider;
}

export interface PolicyContext {
    /** Overrides in force. Absent when policy does not apply, or the client is unknown. */
    overrides?: Record<string, Tier>;
    /** Why policy does not apply, for the log. Absent when it does. */
    unenforced?: string;
    /**
     * The client presented a token but is not in the registry.
     *
     * Kept separate from `unenforced` because the two call for opposite
     * responses: unenforced means run the call, unknown means refuse it.
     */
    unknownClient?: boolean;
}

/**
 * The policy for the client behind the current request.
 *
 * Two cases return `unenforced`, and they are not the same:
 *
 * No provider registered means stdio. There is no OAuth client, so there is no
 * identity to attach permissions to and no way for a user to grant an exception
 * through the settings UI -- a default of `deny` would make the tool
 * permanently unusable with no remedy. Running a stdio server also means
 * spawning a process that already holds the vault key, so the policy would not
 * be a boundary anyway. Not enforced, and said out loud at startup rather than
 * left to be discovered.
 *
 * No clientId on an authenticated request should not happen, and is treated as
 * unenforced rather than as deny: refusing every call because an identity could
 * not be read would present as a total outage for what is a defect here.
 */
export async function resolvePolicy(clientId: string | undefined): Promise<PolicyContext> {
    const active = provider;
    if (!active) return { unenforced: 'no client registry (stdio transport)' };
    if (!clientId) return { unenforced: 'request carried no client id' };

    const overrides = await active.policyFor(clientId);
    if (overrides === undefined) {
        // The client presented a valid token but is no longer registered.
        // verifyAccessToken already rejects this, so reaching here means the
        // two disagree; refuse rather than fall back to defaults, which would
        // give a revoked client exactly what a brand new one gets.
        return { unknownClient: true };
    }

    return { overrides };
}
