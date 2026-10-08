/**
 * Contacts tools for MCP server (RFC 9610 / JSContact RFC 9553)
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getClient } from 'jmap-courier';
import type { ContactCard } from 'jmap-courier';

// ============================================================================
// Tool Schemas
// ============================================================================

export const listAddressBooksSchema = z.object({});

export const searchContactsSchema = z.object({
    text: z.string().describe('Search term (matches name, email, phone number, etc.)'),
    limit: z.coerce.number().finite().optional().default(50).describe('Max results to return (default 50)'),
});

export const getContactSchema = z.object({
    ids: z.array(z.string()).describe('List of contact IDs to fetch'),
});

export const createContactSchema = z.object({
    addressBookId: z.string().describe('ID of the address book to create the contact in'),
    fullName: z.string().describe('Full name of the contact'),
    email: z.string().optional().describe('Email address'),
    phone: z.string().optional().describe('Phone number'),
    company: z.string().optional().describe('Company or organization name'),
    jobTitle: z.string().optional().describe('Job title'),
    notes: z.string().optional().describe('Notes or memo about the contact'),
});

export const updateContactSchema = z.object({
    id: z.string().describe('ID of the contact to update'),
    fullName: z.string().optional().describe('Updated full name'),
    email: z.string().optional().describe('Updated email address'),
    phone: z.string().optional().describe('Updated phone number'),
    company: z.string().optional().describe('Updated company or organization name'),
    jobTitle: z.string().optional().describe('Updated job title'),
    notes: z.string().optional().describe('Updated notes or memo'),
});

export const deleteContactSchema = z.object({
    id: z.string().describe('ID of the contact to delete'),
});

// ============================================================================
// Tool Handlers
// ============================================================================

export async function listAddressBooks() {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const addressBooks = await client.getAddressBooks();

    return {
        addressBooks: addressBooks.map(ab => ({
            id: ab.id,
            name: ab.name,
            parentId: ab.parentId,
            isDefault: ab.isDefault,
        })),
        account: manager.getCurrentAccountName(),
    };
}

export async function searchContacts(params: z.infer<typeof searchContactsSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const limit = Math.min(params.limit || 50, 100);

    const contactIds = await client.queryContacts({ text: params.text }, limit);
    const contacts = await client.getContacts(contactIds);

    return {
        contacts: contacts.map(c => simplifyContactCard(c)),
        account: manager.getCurrentAccountName(),
    };
}

export async function getContact(params: z.infer<typeof getContactSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    const contacts = await client.getContacts(params.ids);

    return {
        contacts: contacts.map(c => simplifyContactCard(c)),
        account: manager.getCurrentAccountName(),
    };
}

export async function createContact(params: z.infer<typeof createContactSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);

    const card: Omit<ContactCard, 'id'> = {
        kind: 'individual',
        name: {
            full: params.fullName,
        },
    };

    if (params.email) {
        card.emails = {
            email1: { address: params.email, contexts: { private: true } },
        };
    }

    if (params.phone) {
        card.phones = {
            phone1: { number: params.phone, contexts: { private: true } },
        };
    }

    if (params.company || params.jobTitle) {
        card.organizations = {
            org1: {
                name: params.company || '',
                title: params.jobTitle,
            },
        };
    }

    if (params.notes) {
        card.notes = { note1: { '@type': 'Note', note: params.notes } };
    }

    const created = await client.createContact(params.addressBookId, card);

    return {
        contact: simplifyContactCard(created),
        account: manager.getCurrentAccountName(),
    };
}

export async function updateContact(params: z.infer<typeof updateContactSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);

    // Fetch the existing contact card to see map keys
    const contacts = await client.getContacts([params.id]);
    if (contacts.length === 0) {
        throw new Error(`Contact not found: ${params.id}`);
    }
    const card = contacts[0];

    const patch: Record<string, unknown> = {};

    if (params.fullName !== undefined) {
        patch['name/full'] = params.fullName;
    }

    if (params.email !== undefined) {
        const firstEmailKey = card.emails ? Object.keys(card.emails)[0] : 'email1';
        if (params.email === '') {
            // Remove email
            patch[`emails/${firstEmailKey}`] = null;
        } else {
            patch[`emails/${firstEmailKey}`] = { address: params.email, contexts: { private: true } };
        }
    }

    if (params.phone !== undefined) {
        const firstPhoneKey = card.phones ? Object.keys(card.phones)[0] : 'phone1';
        if (params.phone === '') {
            // Remove phone
            patch[`phones/${firstPhoneKey}`] = null;
        } else {
            patch[`phones/${firstPhoneKey}`] = { number: params.phone, contexts: { private: true } };
        }
    }

    if (params.company !== undefined || params.jobTitle !== undefined) {
        const firstOrgKey = card.organizations ? Object.keys(card.organizations)[0] : 'org1';
        const existingOrg = card.organizations?.[firstOrgKey];

        const updatedOrg = {
            name: params.company !== undefined ? params.company : (existingOrg?.name ?? ''),
            title: params.jobTitle !== undefined ? params.jobTitle : existingOrg?.title,
        };

        if (updatedOrg.name === '' && !updatedOrg.title) {
            patch[`organizations/${firstOrgKey}`] = null;
        } else {
            patch[`organizations/${firstOrgKey}`] = updatedOrg;
        }
    }

    if (params.notes !== undefined) {
        // A map of Note objects, keyed like every other multi-valued JSContact
        // property. Writing a bare string here silently produced a card the
        // server would not accept.
        const key = card.notes ? Object.keys(card.notes)[0] : 'note1';
        patch[`notes/${key}`] =
            params.notes === '' ? null : { '@type': 'Note', note: params.notes };
    }

    if (Object.keys(patch).length === 0) {
        return {
            success: true,
            contact: simplifyContactCard(card),
            account: manager.getCurrentAccountName(),
        };
    }

    await client.updateContact(params.id, patch);

    const updated = await client.getContacts([params.id]);

    return {
        success: true,
        contact: simplifyContactCard(updated[0]),
        account: manager.getCurrentAccountName(),
    };
}

export async function deleteContact(params: z.infer<typeof deleteContactSchema>) {
    const manager = getAccountManager();
    const account = manager.getCurrentAccount();
    if (!account) {
        throw new Error('No account configured. Set COURIER_API_TOKEN or configure accounts.');
    }

    const client = getClient(account);
    await client.deleteContact(params.id);

    return {
        success: true,
        id: params.id,
        account: manager.getCurrentAccountName(),
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * The displayable name of a contact.
 *
 * `name.full` is what RFC 9553 specifies and what Fastmail stores. This was
 * read as `name.fullName`, which nothing sets -- so every contact came back
 * with `fullName: null` while the name sat in the response untouched. The
 * tools were never run against real data, so nothing caught it.
 *
 * Falls back to assembling the structured components, since a card may carry
 * those without an assembled form. Ordered given-then-surname rather than in
 * array order, because the array is storage order and not a reading order.
 */
function displayName(name: ContactCard['name']): string | null {
    if (name?.full) return name.full;

    const parts = name?.components ?? [];
    const pick = (kind: string) => parts.find((part) => part.kind === kind)?.value;
    const assembled = [pick('given'), pick('surname')].filter(Boolean).join(' ').trim();
    if (assembled) return assembled;

    const anything = parts.map((part) => part.value).filter(Boolean).join(' ').trim();
    return anything || null;
}

/** The first note on a card. RFC 9553 stores these as a map, not a string. */
function firstNote(notes: ContactCard['notes']): string | null {
    const values = notes ? Object.values(notes) : [];
    return values[0]?.note || null;
}

function simplifyContactCard(card: ContactCard) {
    const email = card.emails ? Object.values(card.emails)[0]?.address : null;
    const phone = card.phones ? Object.values(card.phones)[0]?.number : null;
    const org = card.organizations ? Object.values(card.organizations)[0] : null;

    return {
        id: card.id,
        // A card can belong to several address books, so this is a list.
        addressBookIds: Object.keys(card.addressBookIds ?? {}),
        fullName: displayName(card.name),
        email,
        phone,
        company: org?.name || null,
        jobTitle: org?.title || null,
        notes: firstNote(card.notes),
    };
}
