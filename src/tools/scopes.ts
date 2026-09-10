/**
 * Which JMAP capability each tool needs, so Courier adapts to the scope of the
 * token it was given rather than assuming a full-access one.
 *
 * A Fastmail API token can be minted read-only, or mail-only, or without
 * contacts. The session document reports what the credential may use, so a tool
 * the token can never satisfy should not be offered and should not be attempted
 * -- both because the call costs a round trip to earn a 403, and because
 * "Disallowed capabilities for this type/client" tells a user nothing about
 * what to do next.
 *
 * Calendar and task tools are deliberately absent: they run over CalDAV, which
 * has its own credential and is unaffected by JMAP scope. Gating them on a JMAP
 * capability would hide working tools.
 */

import { JMAP_CAPABILITIES } from 'jmap-courier';

const SUBMISSION_TOOLS = ['send_email', 'forward_email'];

const CONTACT_TOOLS = [
    'list_address_books',
    'search_contacts',
    'get_contact',
    'create_contact',
    'update_contact',
    'delete_contact',
];

const MAIL_TOOLS = [
    'list_mailboxes',
    'create_mailbox',
    'rename_mailbox',
    'delete_mailbox',
    'move_mailbox',
    'get_mailbox_details',
    'set_mailbox_role',
    'search_emails',
    'changes_since',
    'get_email',
    'move_emails',
    'delete_emails',
    'mark_emails',
    'tag_emails',
];

const CAPABILITY_BY_TOOL = new Map<string, string>([
    ...MAIL_TOOLS.map((tool) => [tool, JMAP_CAPABILITIES.mail] as const),
    // Sending also writes an Email, but submission is the scope that gates it:
    // a read-only token has neither, and a read-write token without send has
    // mail alone. Naming submission is what makes the error useful.
    ...SUBMISSION_TOOLS.map((tool) => [tool, JMAP_CAPABILITIES.submission] as const),
    ...CONTACT_TOOLS.map((tool) => [tool, JMAP_CAPABILITIES.contacts] as const),
]);

/** The capability a tool needs, or null when it needs none (account, CalDAV). */
export function capabilityForTool(toolName: string): string | null {
    return CAPABILITY_BY_TOOL.get(toolName) ?? null;
}

/**
 * Whether the credential can run this tool.
 *
 * Unknown capability sets permit everything. Absence of evidence is not
 * evidence of absence: if the session could not be read, hiding every tool
 * would turn a transient failure into an apparently empty server.
 */
export function isToolSupported(toolName: string, available: ReadonlySet<string> | null): boolean {
    if (!available) return true;
    const required = capabilityForTool(toolName);
    return required === null || available.has(required);
}

const LABELS: Record<string, string> = {
    [JMAP_CAPABILITIES.mail]: 'read mail',
    [JMAP_CAPABILITIES.submission]: 'send mail',
    [JMAP_CAPABILITIES.contacts]: 'access contacts',
};

/** Says which scope is missing and what to do, rather than quoting a URN. */
export function unsupportedToolMessage(toolName: string): string {
    const required = capabilityForTool(toolName);
    const label = required ? (LABELS[required] ?? required) : 'perform this operation';
    return (
        `"${toolName}" needs permission to ${label}, which this account's API token was not granted. ` +
        `Mint a token with that scope at your provider and update it in Courier's settings, ` +
        `or use a tool that stays within the current token's scope.`
    );
}
