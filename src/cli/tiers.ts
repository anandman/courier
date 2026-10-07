/**
 * The CLI's confirmation gate.
 *
 * Thin by design: the classification itself lives in ../policy/tiers.ts, which
 * the server also reads. Two copies of "which tools are reads" would eventually
 * disagree, and the disagreement would surface as a command refusing locally
 * what the server permits -- or, worse, running locally what the server would
 * have denied.
 *
 * What this layer adds is only *where* the check happens. The CLI gate asks
 * about this invocation, at a terminal, before anything is sent. The server's
 * policy engine asks about this client, for every client, and is the actual
 * enforcement point. A CLI flag is a convenience, not a security boundary: a
 * consumer that wanted to bypass it would simply not use the CLI.
 */

import { READ_ONLY_TOOLS, consequenceOf } from '../policy/tiers.js';

export { READ_ONLY_TOOLS };

/**
 * Whether this tool needs `--yes`, or an interactive confirmation.
 *
 * Derived from the shared read/write classification, NOT from the server's
 * default tier, because the two answer different questions. The server's tier
 * asks "may this client do this at all"; `--yes` asks "did the person typing
 * this mean it". A tool can perfectly well be permitted for the CLI and still
 * worth a beat before it runs -- drafting into a real mailbox is the obvious
 * case, and the server now allows it because it is reversible, which is not a
 * reason to stop asking the person at the keyboard.
 *
 * Tying them together would also mean a settings change on the server silently
 * altered what a command does locally, which is not a connection anyone would
 * expect.
 */
export function requiresConfirmation(toolName: string): boolean {
    return !READ_ONLY_TOOLS.has(toolName);
}

/** Why, phrased for the person who just hit the gate. */
export function confirmationReason(toolName: string): string {
    return consequenceOf(toolName);
}
