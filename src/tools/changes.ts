/**
 * Incremental mail changes, so a caller can poll cheaply instead of searching.
 *
 * A consumer watching 11 sender domains was running 24 searches per poll --
 * ~48 HTTP requests, since each search is a query then a get -- to discover
 * that usually nothing had changed. This is one request.
 *
 * The cheapness is the point, and the latency follows from it: once a poll
 * costs a single round trip, a one-minute timer is far cheaper than the
 * half-hourly search sweep it replaces. That is why this exists rather than a
 * push/EventSource path, which would need a long-lived connection Courier's
 * stateless HTTP transport has nowhere to keep.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email, EmailSummary } from 'jmap-courier';
import { toEmailSummary } from './search.js';

export const changesSinceSchema = z.object({
    state: z
        .string()
        .optional()
        .describe(
            'The state string from a previous call. Omit on first use to receive the current state and no changes, flagged bootstrapped: true -- which means NO HISTORY EXISTS before that point, not that nothing has changed. Cover the preceding window with search_emails before relying on this feed. Store the returned state only after a successful call.'
        ),
    mailboxes: z
        .array(z.string())
        .optional()
        .describe(
            'Limit results to these mailboxes by name, role or id ("Inbox", "Sent"). Omit to receive changes from the whole account, which is the raw JMAP behaviour. Messages that changed but now sit outside this scope are reported separately in departedIds so a caller can drop them.'
        ),
    maxChanges: z.coerce
        .number()
        .finite()
        .optional()
        .default(128)
        .describe('Maximum changes per call (default 128). If hasMoreChanges is true, call again with the returned state.'),
});

export interface ChangesSinceResult {
    /** Pass back as `state` next time. Store only after a successful call. */
    newState: string;
    /** True when changes remain beyond maxChanges; call again with newState. */
    hasMoreChanges: boolean;
    /**
     * True when no state was supplied.
     *
     * **This is not success-with-nothing-new.** It means the feed has no
     * history before `newState`: everything up to that moment is unaccounted
     * for, and only a full sync can cover it. A caller treating this like an
     * ordinary empty delta silently loses the entire preceding window -- which
     * cost one consumer 26 hours of mail, 14 messages, on its first real run.
     */
    bootstrapped: boolean;
    /**
     * Present only on bootstrap. Prose, because the primary caller is a model
     * reading the payload, and a bare boolean is too easy to read as
     * reassurance.
     */
    note?: string;
    created: EmailSummary[];
    updated: EmailSummary[];
    /** Genuinely expunged from the account. */
    destroyedIds: string[];
    /**
     * Changed, but no longer in the requested mailboxes -- filed elsewhere,
     * trashed, or archived. Empty when no mailbox scope was given.
     *
     * Without this a scoped feed is worse than an unscoped one: a message
     * leaving the scope would simply stop appearing, and a caller would hold it
     * as current forever with nothing to say otherwise.
     */
    departedIds: string[];
    account: string | null;
}

export async function changesSince(
    params: z.infer<typeof changesSinceSchema>
): Promise<ChangesSinceResult> {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();

    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const accountName = manager.getCurrentAccountName();

    // Validate the scope before anything else, including the bootstrap return.
    //
    // Bootstrap is the ONE call where a caller writes the mailbox names for the
    // first time, so it is exactly where a typo happens -- and it used to be
    // the one path that skipped this check. The caller stored the state, every
    // later poll passed it and errored correctly, but by then nobody was
    // looking, because the first call had "worked". Resolving by role first
    // also means "Junk" finds a folder named "Spam".
    const scope = await resolveScope(client, params.mailboxes);

    // No state means "where do I start?", never "give me everything". A delta
    // tool that quietly returned a whole mailbox would look like it worked.
    if (!params.state) {
        return {
            newState: await client.getEmailState(),
            hasMoreChanges: false,
            bootstrapped: true,
            note:
                'No history exists before this state. This is a starting point, NOT a report that nothing changed. ' +
                'Anything that arrived before now is not in this response and never will be -- cover that window with ' +
                'search_emails, then poll with the returned state.',
            created: [],
            updated: [],
            destroyedIds: [],
            departedIds: [],
            account: accountName,
        };
    }

    const changes = await client.getEmailChanges(params.state, { maxChanges: params.maxChanges });

    const inScope = (email: Email): boolean =>
        scope === null || Object.keys(email.mailboxIds ?? {}).some((id) => scope.has(id));

    const departedIds = scope === null
        ? []
        : [...changes.created, ...changes.updated].filter((e) => !inScope(e)).map((e) => e.id);

    return {
        newState: changes.newState,
        hasMoreChanges: changes.hasMoreChanges,
        bootstrapped: false,
        created: changes.created.filter(inScope).map(toEmailSummary),
        updated: changes.updated.filter(inScope).map(toEmailSummary),
        destroyedIds: changes.destroyedIds,
        departedIds,
        account: accountName,
    };
}

/**
 * Mailbox names to ids. Returns null for "no scope".
 *
 * An unresolvable name is an error rather than an empty scope: silently
 * matching nothing would report "no changes" for a mailbox that is simply
 * misspelled, which is indistinguishable from a quiet mailbox.
 */
async function resolveScope(
    client: ReturnType<typeof getClient>,
    mailboxes?: string[]
): Promise<Set<string> | null> {
    if (!mailboxes || mailboxes.length === 0) return null;

    const ids = new Set<string>();
    for (const name of mailboxes) {
        const mailbox = await client.resolveMailbox(name);
        if (!mailbox) {
            throw new Error(
                `Mailbox "${name}" not found. Use list_mailboxes to see what is available.`
            );
        }
        ids.add(mailbox.id);
    }
    return ids;
}
