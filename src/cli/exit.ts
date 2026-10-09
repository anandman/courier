/**
 * The CLI's exit-code contract.
 *
 * Designed before anything else, because for an unattended consumer the exit
 * code *is* the interface. A script writes `courier search-emails ... || exit`
 * and never reads the prose; whatever distinctions are not in the number do not
 * exist as far as that script is concerned.
 *
 * One rule governs every code below, and it comes from the failure this project
 * keeps producing: a value that could mean either "I looked and found little"
 * or "I could not look" must never be the former by default. Concretely:
 *
 *   Exit 0 means the server answered the exact question asked, completely.
 *
 * Everything else is non-zero, and a non-zero exit writes NOTHING data-shaped
 * to stdout. Not a partial page set, not an empty array, not `{}`. A consumer
 * that pipes stdout into a cache must be unable to ingest a failure, even if it
 * ignores the exit code entirely -- there is nothing there to ingest. The
 * corollary is that an empty result WITH exit 0 is trustworthy and means zero
 * matches, which is the whole point of being strict everywhere else.
 *
 * Codes are stable: a number's meaning never changes once published, and new
 * conditions get new numbers. All are below 10, leaving the shell's reserved
 * 126/127/128+N range alone.
 */

export const EXIT = {
    /** The server answered the question, completely. stdout holds the result. */
    OK: 0,

    /**
     * A defect in the CLI. Anything that could not be classified lands here
     * rather than being flattened into a plausible-looking neighbour, because a
     * miscategorised failure teaches the caller to retry the wrong thing.
     */
    INTERNAL: 1,

    /**
     * The caller's fault, locally: unknown subcommand, unknown flag, missing
     * required argument, a value the tool's schema rejects. Nothing was sent.
     * Retrying the same command cannot help.
     */
    USAGE: 2,

    /**
     * No stored credentials for this server. Distinct from AUTH_REJECTED on
     * purpose: this one has never worked, so a human running `courier auth
     * login` is the only cure, and no amount of waiting changes it.
     */
    NO_AUTH: 3,

    /**
     * The server refused the credentials we held: the access token was rejected
     * and the refresh token could not renew it, or the client registration no
     * longer exists. Also a human running `courier auth login` -- but worth
     * separating from NO_AUTH because this one means something was revoked,
     * which is a security-relevant event rather than a setup step.
     */
    AUTH_REJECTED: 4,

    /**
     * Authenticated, and refused anyway: the tool is denied for this client, or
     * it requires a human confirmation this invocation cannot obtain. A
     * confirmation-gated tool run non-interactively lands here rather than
     * silently proceeding or silently skipping.
     */
    FORBIDDEN: 5,

    /**
     * No answer could be obtained from the server: DNS failure, connection
     * refused, TLS failure, timeout, 5xx, or a response that was not valid MCP.
     * This is the one code a caller may retry unchanged.
     */
    UNREACHABLE: 6,

    /**
     * The server answered, and the answer was "this failed". Covers both shapes
     * MCP uses: a JSON-RPC error, and a result carrying `isError` on the
     * envelope. The second shape is the dangerous one -- it arrives as a
     * successful JSON-RPC response, and a client that only unwraps
     * `content[].text` reads it as a result with no keys, which is to say an
     * empty answer. This CLI checks both so its callers never have to.
     */
    TOOL_ERROR: 7,

    /**
     * The server's own upstream credential -- the JMAP API token or the DAV
     * app password -- was rejected by the mail provider.
     *
     * The one failure that neither retrying nor re-authorising fixes: a human
     * must rotate a credential on the provider's side. Separating it matters
     * because an unattended consumer otherwise has two bad options, retry
     * forever or stop for every tool error, and the right response is neither.
     *
     * Carried by an `errorCode` the server sets, never inferred from the
     * message. Matching on wording is how a classification rots silently while
     * continuing to look authoritative.
     */
    UPSTREAM_AUTH: 8,

    /**
     * The answer exists but could not be retrieved in full: a paged read that
     * succeeded for some pages and then failed.
     *
     * This exists so that the partial set is never mistaken for the whole one.
     * The pages already fetched are discarded rather than printed, because a
     * truncated answer that looks well-formed is worse than no answer -- it is
     * precisely the shape that has cost this project real data.
     */
    INCOMPLETE: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Short machine-readable name for each code, used in diagnostics and `courier exit-codes`. */
export const EXIT_NAMES: Readonly<Record<number, string>> = {
    [EXIT.OK]: 'ok',
    [EXIT.INTERNAL]: 'internal',
    [EXIT.USAGE]: 'usage',
    [EXIT.NO_AUTH]: 'no-auth',
    [EXIT.AUTH_REJECTED]: 'auth-rejected',
    [EXIT.FORBIDDEN]: 'forbidden',
    [EXIT.UNREACHABLE]: 'unreachable',
    [EXIT.TOOL_ERROR]: 'tool-error',
    [EXIT.UPSTREAM_AUTH]: 'upstream-auth',
    [EXIT.INCOMPLETE]: 'incomplete',
};

/**
 * Whether retrying the identical command could plausibly succeed.
 *
 * Only UNREACHABLE qualifies. Everything else needs the command, the
 * credentials, or the provider's state to change first, and a consumer looping
 * on them just burns a rate limit while looking busy. Published as code rather
 * than prose so a wrapper can branch on it without re-deriving the table.
 */
export function isRetriable(code: number): boolean {
    return code === EXIT.UNREACHABLE;
}

/** Whether a human has to do something before this command can work. */
export function needsHuman(code: number): boolean {
    return code === EXIT.NO_AUTH || code === EXIT.AUTH_REJECTED || code === EXIT.UPSTREAM_AUTH;
}

/**
 * A failure that knows its own exit code.
 *
 * `hint` is the actionable half -- the command to run, the flag to pass -- kept
 * separate from `message` so the two can be formatted differently and so a hint
 * is never mistaken for part of the diagnosis.
 */
export class CliError extends Error {
    readonly code: ExitCode;
    readonly hint?: string;

    constructor(code: ExitCode, message: string, hint?: string) {
        super(message);
        this.name = 'CliError';
        this.code = code;
        this.hint = hint;
    }
}

export interface ExitCodeDescription {
    code: number;
    name: string;
    retriable: boolean;
    needsHuman: boolean;
    emitted: boolean;
    meaning: string;
}

/**
 * The contract, as data.
 *
 * `courier exit-codes` prints this so a consumer can assert against the table
 * it was written for instead of hardcoding numbers that may gain siblings.
 * `emitted: false` marks a reserved code that nothing produces yet -- a
 * consumer should handle it, but must not wait for it as a signal.
 */
export function describeExitCodes(): ExitCodeDescription[] {
    const meanings: Record<number, { meaning: string; emitted?: boolean }> = {
        [EXIT.OK]: { meaning: 'The server answered the question in full; stdout holds the result.' },
        [EXIT.INTERNAL]: { meaning: 'A defect in the CLI itself.' },
        [EXIT.USAGE]: { meaning: 'Bad command line; nothing was sent to the server.' },
        [EXIT.NO_AUTH]: { meaning: 'No stored credentials for this server. Run: courier auth login' },
        [EXIT.AUTH_REJECTED]: {
            meaning: 'The server rejected the stored credentials and they could not be renewed.',
        },
        [EXIT.FORBIDDEN]: {
            meaning: 'Authenticated but not permitted, or a confirmation was required and could not be obtained.',
        },
        [EXIT.UNREACHABLE]: { meaning: 'No answer could be obtained from the server. Safe to retry.' },
        [EXIT.TOOL_ERROR]: { meaning: 'The server answered, and the operation failed.' },
        [EXIT.UPSTREAM_AUTH]: {
            meaning:
                "The server's own credential for the mail provider was rejected. Retrying will not help; a human must replace it.",
        },
        [EXIT.INCOMPLETE]: {
            meaning: 'A paged read failed part way through. The partial result is discarded, not printed.',
        },
    };

    return Object.values(EXIT)
        .slice()
        .sort((a, b) => a - b)
        .map((code) => ({
            code,
            name: EXIT_NAMES[code],
            retriable: isRetriable(code),
            needsHuman: needsHuman(code),
            emitted: meanings[code]?.emitted ?? true,
            meaning: meanings[code]?.meaning ?? '',
        }));
}
