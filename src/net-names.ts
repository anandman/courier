/**
 * Turns a recorded client address into something a person recognises.
 *
 * The settings UI stores where each client was last seen, but `100.64.0.2`
 * does not answer "which machine" for anyone who has not memorised their own
 * address plan. A reverse lookup turns it into `workstation.example.ts.net`.
 *
 * Reverse DNS rather than anything Tailscale-specific: PTR records are the
 * standard way a network names its own hosts, and they work the same for
 * MagicDNS, a corporate resolver, or a cloud provider's reverse zone. A
 * deployment with no PTR records simply keeps seeing addresses, which is what it
 * would have seen anyway.
 */

import { promises as dns } from 'node:dns';

/** How long a resolved name is trusted. Hostnames change rarely; this is a UI label. */
const TTL_MS = 10 * 60 * 1000;
/** A page render must not wait on a slow resolver. */
const TIMEOUT_MS = 300;

const cache = new Map<string, { name: string | null; at: number }>();

async function reverse(address: string): Promise<string | null> {
    const hit = cache.get(address);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.name;

    let name: string | null = null;
    try {
        const names = await Promise.race([
            dns.reverse(address),
            new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
        ]);
        name = names[0] ?? null;
    } catch {
        // No PTR, no resolver, or too slow. The address is still the truth.
        name = null;
    }

    cache.set(address, { name, at: Date.now() });
    return name;
}

/**
 * Resolves each address to a hostname where one exists.
 *
 * Never rejects and never blocks longer than the timeout: a name here is a
 * convenience, and failing to find one must not cost the caller its page.
 */
export async function describeAddresses(
    addresses: readonly (string | undefined)[]
): Promise<Map<string, string>> {
    const unique = [...new Set(addresses.filter((a): a is string => !!a))];
    const resolved = await Promise.all(unique.map(async (a) => [a, await reverse(a)] as const));

    const names = new Map<string, string>();
    for (const [address, name] of resolved) {
        if (name) names.set(address, name);
    }
    return names;
}
