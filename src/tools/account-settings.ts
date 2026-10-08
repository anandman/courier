/**
 * Account-level settings that are neither mail nor calendar: the auto-reply,
 * and masked addresses.
 *
 * Both were available on this account all along and neither was exposed. They
 * surfaced only when the session's capability list was read directly --
 * `vacationresponse` and `maskedemail` sitting there next to `mail` and
 * `contacts`, with no tool able to touch either.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';

function clientFor() {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }
    return { client: getClient(account), manager };
}

// ---------------------------------------------------------------------------
// Vacation responder
// ---------------------------------------------------------------------------

export const getVacationResponderSchema = z.object({});

export const setVacationResponderSchema = z.object({
    isEnabled: z.boolean().describe('Turn the auto-reply on or off.'),
    subject: z.string().optional().describe('Subject of the auto-reply. Omit to keep the current one.'),
    body: z.string().optional().describe('Plain-text body. Omit to keep the current one.'),
    fromDate: z
        .string()
        .optional()
        .describe('ISO 8601 date-time to start replying, in UTC. Omit for "from now"; pass an empty string to clear.'),
    toDate: z
        .string()
        .optional()
        .describe('ISO 8601 date-time to stop, in UTC. Omit to leave unchanged; pass an empty string to clear, meaning it runs until turned off.'),
});

/**
 * Presentation shared by both tools, so what you read back after a change is
 * the same shape you read before it.
 */
function describeVacation(v: {
    isEnabled: boolean;
    fromDate: string | null;
    toDate: string | null;
    subject: string | null;
    textBody: string | null;
    isToContactsOnly?: boolean;
}) {
    return {
        isEnabled: v.isEnabled,
        subject: v.subject,
        body: v.textBody,
        fromDate: v.fromDate,
        toDate: v.toDate,
        // Reported because it changes who gets a reply, and it is invisible
        // otherwise: an auto-reply that is on but answers only contacts looks
        // broken to anyone testing it from an unknown address.
        repliesToContactsOnly: v.isToContactsOnly ?? false,
    };
}

export async function getVacationResponder() {
    const { client, manager } = clientFor();
    const current = await client.getVacationResponse();

    return {
        ...describeVacation(current),
        account: manager.getCurrentAccountName(),
    };
}

/**
 * Changes the auto-reply.
 *
 * Outward-facing in a way that is easy to miss: switching this on makes the
 * account reply to strangers, repeatedly, until someone turns it off. It is not
 * a single message so it cannot be unsent, and the person who turned it on is
 * usually not the one who notices.
 */
export async function setVacationResponder(params: z.infer<typeof setVacationResponderSchema>) {
    const { client, manager } = clientFor();

    const patch: Record<string, unknown> = { isEnabled: params.isEnabled };
    if (params.subject !== undefined) patch.subject = params.subject;
    if (params.body !== undefined) patch.textBody = params.body;
    // An empty string clears a date; omitting it leaves the date alone. Without
    // the distinction there is no way to say "run indefinitely" once an end
    // date has been set.
    if (params.fromDate !== undefined) patch.fromDate = params.fromDate === '' ? null : params.fromDate;
    if (params.toDate !== undefined) patch.toDate = params.toDate === '' ? null : params.toDate;

    if (params.isEnabled && !params.subject && !params.body) {
        const existing = await client.getVacationResponse();
        if (!existing.subject && !existing.textBody) {
            throw new Error(
                'Turning the auto-reply on with no subject and no body would send empty replies to everyone who writes. Pass a subject, a body, or both.'
            );
        }
    }

    const updated = await client.setVacationResponse(patch);

    return {
        ...describeVacation(updated),
        message: updated.isEnabled
            ? `Auto-reply is ON${updated.toDate ? ` until ${updated.toDate}` : ' until you turn it off'}. Everyone who writes will receive it.`
            : 'Auto-reply is OFF.',
        account: manager.getCurrentAccountName(),
    };
}

// ---------------------------------------------------------------------------
// Masked addresses
// ---------------------------------------------------------------------------

export const listMaskedEmailsSchema = z.object({
    state: z
        .enum(['pending', 'enabled', 'disabled', 'deleted'])
        .optional()
        .describe('Only addresses in this state. Omit for all of them except deleted.'),
    forDomain: z.string().optional().describe('Only addresses created for this site.'),
});

export const createMaskedEmailSchema = z.object({
    emailPrefix: z
        .string()
        .optional()
        .describe(
            'A word to begin the address with, e.g. "shop" gives shop.something@yourdomain. Worth setting when a person will see the address in a password manager later; omit to let the server choose both words.'
        ),
    forDomain: z
        .string()
        .optional()
        .describe('The site this address is for, e.g. "example.com". Fastmail labels and groups by it, so it is worth setting.'),
    description: z.string().optional().describe('A note to yourself about what this address is for.'),
    enabled: z
        .boolean()
        .optional()
        .default(true)
        .describe('Create it ready to receive mail. False creates it pending, which Fastmail reclaims if nothing ever arrives.'),
});

export const updateMaskedEmailSchema = z.object({
    id: z.string().describe('The masked address to change (use an id from list_masked_emails).'),
    state: z
        .enum(['enabled', 'disabled', 'deleted'])
        .optional()
        .describe(
            'enabled accepts mail; disabled bounces it and can be re-enabled; deleted retires the address permanently. PREFER disabled while migrating a site -- the address cannot be recreated once deleted. Whether mail still reaches the account afterwards depends on a catch-all on the domain, which this server cannot see.'
        ),
    description: z.string().optional().describe('Replacement note. Omit to leave unchanged.'),
});

export async function listMaskedEmails(params: z.infer<typeof listMaskedEmailsSchema>) {
    const { client, manager } = clientFor();
    const all = await client.getMaskedEmails();

    const filtered = all
        // Deleted addresses are excluded unless asked for: they are retired and
        // listing them by default buries the ones that matter.
        .filter((masked) => (params.state ? masked.state === params.state : masked.state !== 'deleted'))
        .filter((masked) => !params.forDomain || masked.forDomain === params.forDomain);

    return {
        maskedEmails: filtered.map((masked) => ({
            id: masked.id,
            email: masked.email,
            state: masked.state,
            forDomain: masked.forDomain || null,
            description: masked.description || null,
            createdAt: masked.createdAt,
            lastMessageAt: masked.lastMessageAt,
        })),
        returned: filtered.length,
        // Said explicitly so a filtered view cannot be mistaken for the whole
        // set -- including the deleted ones this hides by default.
        totalOnAccount: all.length,
        account: manager.getCurrentAccountName(),
    };
}

export async function createMaskedEmail(params: z.infer<typeof createMaskedEmailSchema>) {
    const { client, manager } = clientFor();

    const created = await client.createMaskedEmail({
        emailPrefix: params.emailPrefix,
        forDomain: params.forDomain,
        description: params.description,
        state: params.enabled ? 'enabled' : 'pending',
    });

    // Read back rather than report the create response.
    //
    // MaskedEmail/set echoes only the properties the SERVER set -- the id and
    // the address -- so state, forDomain and description came back undefined
    // while being stored perfectly well. Reporting the request as though it
    // were the record is the mistake this file avoids everywhere else; it was
    // only missing here.
    const all = await client.getMaskedEmails();
    const stored = all.find((masked) => masked.id === created.id);
    if (!stored) {
        throw new Error(
            `${created.email} was created but could not be read back, so its settings are unconfirmed.`
        );
    }

    return {
        id: stored.id,
        email: stored.email,
        state: stored.state,
        forDomain: stored.forDomain || null,
        description: stored.description || null,
        message: `Created ${stored.email}. Mail sent to it arrives in this account, and it can be disabled or retired without affecting any other address.`,
        account: manager.getCurrentAccountName(),
    };
}

export async function updateMaskedEmail(params: z.infer<typeof updateMaskedEmailSchema>) {
    const { client, manager } = clientFor();
    if (params.state === undefined && params.description === undefined) {
        throw new Error('Nothing to change: pass state, description, or both.');
    }

    await client.updateMaskedEmail(params.id, {
        state: params.state,
        description: params.description,
    });

    // Read back rather than echo the request, so the result reports what is
    // stored rather than what was asked for.
    const all = await client.getMaskedEmails();
    const updated = all.find((masked) => masked.id === params.id);
    if (!updated) {
        throw new Error(`${params.id} was updated but could not be read back, so its current state is unknown.`);
    }

    return {
        id: updated.id,
        email: updated.email,
        state: updated.state,
        description: updated.description || null,
        message:
            updated.state === 'deleted'
                ? `${updated.email} is retired and cannot be recreated. Whether mail sent to it still reaches the account depends on whether the domain has a catch-all, which Courier cannot determine -- on a domain without one, it is gone.`
                : updated.state === 'disabled'
                  ? `${updated.email} is disabled. Mail sent to it will bounce.`
                  : `${updated.email} is enabled and receiving mail.`,
        account: manager.getCurrentAccountName(),
    };
}
