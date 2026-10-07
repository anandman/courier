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

import { READ_ONLY_TOOLS, consequenceOf, defaultTierFor } from '../policy/tiers.js';

export { READ_ONLY_TOOLS };

/** Whether this tool needs `--yes`, or an interactive confirmation. */
export function requiresConfirmation(toolName: string): boolean {
    return defaultTierFor(toolName) !== 'allow';
}

/** Why, phrased for the person who just hit the gate. */
export function confirmationReason(toolName: string): string {
    return consequenceOf(toolName);
}
