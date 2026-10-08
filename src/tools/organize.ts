/**
 * Bulk organisation: move, trash, flag and tag, several messages at a time.
 *
 * Each of these reports per message rather than per batch. JMAP applies an
 * Email/set per id, so a batch genuinely can half succeed -- and the previous
 * shape, a count and a cheerful sentence, could say "Moved 100 email(s)" when
 * three of them had not moved, or raise a single error after ninety-seven had.
 * Neither told a caller which was which.
 *
 * Each result also carries the state the message was in beforehand: the
 * mailboxes it was in, the keywords it had. That is what makes a mistake
 * recoverable without this server storing anything. An undo token would mean
 * keeping prior state here, with a lifetime and a store to manage; the same
 * information handed back to the caller costs nothing to keep and cannot go
 * stale, because the caller reverses it or does not.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { Email } from 'jmap-courier';

/** What one message was before the change, and whether the change applied. */
export interface EmailChangeResult {
    emailId: string;
    ok: boolean;
    /** Mailbox names the message was in beforehand. Move it back to these to reverse. */
    previousMailboxes?: string[];
    /** Keywords it carried beforehand, for the same reason. */
    previousKeywords?: string[];
    /** Why it did not change. Present only when ok is false. */
    reason?: string;
}

export interface BulkResult {
    /** True only when every requested message changed. */
    success: boolean;
    /** How many changed. Named `count` as before, so existing callers keep working. */
    count: number;
    requested: number;
    failed: number;
    results: EmailChangeResult[];
    message: string;
    account: string | null;
}

function clientFor() {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }
    return { client: getClient(account), manager };
}

function empty(manager: ReturnType<typeof getAccountManager>, what: string): BulkResult {
    return {
        success: true,
        count: 0,
        requested: 0,
        failed: 0,
        results: [],
        message: `No emails to ${what}`,
        account: manager.getCurrentAccountName(),
    };
}

/**
 * Reads the state of each message before changing it.
 *
 * One extra round trip for the whole batch, which buys the only thing that
 * makes a bulk change reversible by its caller. A message that cannot be read
 * is not treated as an error here -- it will fail the update too, and reporting
 * it twice in different words helps nobody.
 */
async function priorState(
    client: ReturnType<typeof getClient>,
    emailIds: string[]
): Promise<Map<string, { mailboxes: string[]; keywords: string[] }>> {
    const [emails, mailboxes] = await Promise.all([
        client.getEmails(emailIds),
        client.getMailboxes(),
    ]);
    const nameById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.name]));

    return new Map(
        emails.map((email: Email) => [
            email.id,
            {
                mailboxes: Object.keys(email.mailboxIds ?? {})
                    .filter((id) => email.mailboxIds?.[id])
                    .map((id) => nameById.get(id) ?? id),
                keywords: Object.keys(email.keywords ?? {}).filter((key) => email.keywords?.[key]),
            },
        ])
    );
}

/** Assembles the per-message report from what JMAP said happened. */
function describeOutcome(
    emailIds: string[],
    before: Map<string, { mailboxes: string[]; keywords: string[] }>,
    notUpdated: Record<string, { type: string; description?: string }>,
    manager: ReturnType<typeof getAccountManager>,
    summarise: (succeeded: number, failed: number) => string
): BulkResult {
    const results: EmailChangeResult[] = emailIds.map((emailId) => {
        const failure = notUpdated[emailId];
        const prior = before.get(emailId);
        return failure
            ? {
                  emailId,
                  ok: false,
                  reason: failure.description ?? failure.type,
              }
            : {
                  emailId,
                  ok: true,
                  previousMailboxes: prior?.mailboxes,
                  previousKeywords: prior?.keywords,
              };
    });

    const failed = results.filter((result) => !result.ok).length;
    const succeeded = results.length - failed;

    return {
        // False when anything failed. A partial batch must never report success:
        // a caller checking one boolean is the common case, and it should be
        // wrong in the safe direction.
        success: failed === 0,
        count: succeeded,
        requested: emailIds.length,
        failed,
        results,
        message: summarise(succeeded, failed),
        account: manager.getCurrentAccountName(),
    };
}

// Tool schemas
export const moveEmailsSchema = z.object({
    emailIds: z.array(z.string()).describe('IDs of emails to move (use IDs from search_emails to avoid extra reads)'),
    mailbox: z.string().describe('Target mailbox name or ID'),
});

export const deleteEmailsSchema = z.object({
    emailIds: z.array(z.string()).describe('IDs of emails to delete (move to trash). Use IDs from search_emails.'),
});

export const markEmailsSchema = z.object({
    emailIds: z.array(z.string()).describe('IDs of emails to mark (use IDs from search_emails)'),
    isRead: z.boolean().optional().describe('Set read status (true = read, false = unread)'),
    isFlagged: z.boolean().optional().describe('Set flagged/starred status'),
});

export const tagEmailsSchema = z.object({
    emailIds: z.array(z.string()).describe('IDs of emails to tag (use IDs from search_emails)'),
    addKeywords: z.array(z.string()).optional().describe('Keywords/tags to add'),
    removeKeywords: z.array(z.string()).optional().describe('Keywords/tags to remove'),
});


export async function moveEmails(params: z.infer<typeof moveEmailsSchema>): Promise<BulkResult> {
    const { client, manager } = clientFor();
    if (params.emailIds.length === 0) return empty(manager, 'move');

    const mailbox = await client.resolveMailbox(params.mailbox);
    if (!mailbox) {
        throw new Error(`Mailbox not found: ${params.mailbox}`);
    }

    const before = await priorState(client, params.emailIds);
    const { notUpdated } = await client.updateEmailsDetailed(
        Object.fromEntries(
            params.emailIds.map((id) => [id, { mailboxIds: { [mailbox.id]: true } }])
        )
    );

    return describeOutcome(params.emailIds, before, notUpdated, manager, (ok, failed) =>
        failed === 0
            ? `Moved ${ok} email(s) to "${mailbox.name}". Each result lists the mailboxes it came from, so this can be reversed.`
            : `Moved ${ok} of ${params.emailIds.length} email(s) to "${mailbox.name}"; ${failed} did not move. See results for which and why.`
    );
}

export async function deleteEmails(params: z.infer<typeof deleteEmailsSchema>): Promise<BulkResult> {
    const { client, manager } = clientFor();
    if (params.emailIds.length === 0) return empty(manager, 'delete');

    const trash = await client.getMailboxByRole('trash');
    if (!trash) {
        throw new Error('Trash mailbox not found, so there is nowhere to move these.');
    }

    const before = await priorState(client, params.emailIds);
    const { notUpdated } = await client.updateEmailsDetailed(
        Object.fromEntries(params.emailIds.map((id) => [id, { mailboxIds: { [trash.id]: true } }]))
    );

    return describeOutcome(params.emailIds, before, notUpdated, manager, (ok, failed) =>
        failed === 0
            ? `Moved ${ok} email(s) to Trash, where they can be recovered. Each result lists the mailboxes it came from.`
            : `Moved ${ok} of ${params.emailIds.length} email(s) to Trash; ${failed} did not move. See results for which and why.`
    );
}

export async function markEmails(params: z.infer<typeof markEmailsSchema>): Promise<BulkResult> {
    const { client, manager } = clientFor();
    if (params.emailIds.length === 0) return empty(manager, 'mark');
    if (params.isRead === undefined && params.isFlagged === undefined) {
        throw new Error('Nothing to change: pass isRead, isFlagged, or both.');
    }

    const patch: Record<string, boolean | null> = {};
    if (params.isRead !== undefined) patch['keywords/$seen'] = params.isRead ? true : null;
    if (params.isFlagged !== undefined) patch['keywords/$flagged'] = params.isFlagged ? true : null;

    const before = await priorState(client, params.emailIds);
    const { notUpdated } = await client.updateEmailsDetailed(
        Object.fromEntries(params.emailIds.map((id) => [id, patch]))
    );

    const changed = [
        params.isRead !== undefined ? (params.isRead ? 'read' : 'unread') : null,
        params.isFlagged !== undefined ? (params.isFlagged ? 'flagged' : 'unflagged') : null,
    ]
        .filter(Boolean)
        .join(' and ');

    return describeOutcome(params.emailIds, before, notUpdated, manager, (ok, failed) =>
        failed === 0
            ? `Marked ${ok} email(s) ${changed}. Each result lists the keywords it had beforehand.`
            : `Marked ${ok} of ${params.emailIds.length} email(s) ${changed}; ${failed} did not change. See results for which and why.`
    );
}

export async function tagEmails(params: z.infer<typeof tagEmailsSchema>): Promise<BulkResult> {
    const { client, manager } = clientFor();
    if (params.emailIds.length === 0) return empty(manager, 'tag');
    if (!params.addKeywords?.length && !params.removeKeywords?.length) {
        throw new Error('Nothing to change: pass addKeywords, removeKeywords, or both.');
    }

    const patch: Record<string, boolean | null> = {};
    for (const keyword of params.addKeywords ?? []) patch[`keywords/${keyword}`] = true;
    for (const keyword of params.removeKeywords ?? []) patch[`keywords/${keyword}`] = null;

    const before = await priorState(client, params.emailIds);
    const { notUpdated } = await client.updateEmailsDetailed(
        Object.fromEntries(params.emailIds.map((id) => [id, patch]))
    );

    return describeOutcome(params.emailIds, before, notUpdated, manager, (ok, failed) =>
        failed === 0
            ? `Tagged ${ok} email(s). Each result lists the keywords it had beforehand, so this can be reversed exactly.`
            : `Tagged ${ok} of ${params.emailIds.length} email(s); ${failed} did not change. See results for which and why.`
    );
}
