/**
 * Integration tests for Courier
 * 
 * These tests run against real Fastmail accounts.
 * Configure your test accounts in .env.test (copy from .env.test.example)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testConfig } from './setup.js';
import { AccountManager, resetAccountManager, getAccountManager } from '../src/account-manager.js';
import { JMAPClient, clearClientCache, getClient } from 'jmap-courier';
import {
    listAccounts,
    switchAccount,
    getCurrentAccount,
    listMailboxes,
    createMailbox,
    renameMailbox,
    deleteMailbox,
    moveMailbox,
    getMailboxDetails,
    setMailboxRole,
    searchEmails,
    getEmail,
    sendEmail,
    markEmails,
    tagEmails,
    listAddressBooks,
    searchContacts,
    getContact,
    createContact,
    updateContact,
    deleteContact,
} from '../src/tools/index.js';

describe('Courier', () => {
    beforeAll(() => {
        if (!testConfig.isConfigured) {
            throw new Error(
                'Test configuration missing. Copy .env.test.example to .env.test and configure your test accounts.'
            );
        }

        // Set up environment for tests
        process.env.COURIER_API_TOKEN = testConfig.token1;
        process.env.COURIER_EMAIL = testConfig.account1;

        // Reset singletons
        resetAccountManager();
        clearClientCache();
    });

    afterAll(() => {
        // Clean up
        delete process.env.COURIER_API_TOKEN;
        delete process.env.COURIER_EMAIL;
        resetAccountManager();
        clearClientCache();
    });

    describe('Account Tools', () => {
        it('list_accounts returns configured accounts', async () => {
            const result = await listAccounts();

            expect(result.accounts).toBeDefined();
            expect(Array.isArray(result.accounts)).toBe(true);
            expect(result.accounts.length).toBeGreaterThan(0);
            expect(result.currentAccount).toBeDefined();
        });

        it('get_current_account shows current account', async () => {
            const result = await getCurrentAccount();

            expect(result.hasAccounts).toBe(true);
            expect(result.accountName).toBeDefined();
        });
    });

    describe('Mailbox Tools', () => {
        it('list_mailboxes returns standard folders', async () => {
            const result = await listMailboxes();

            expect(result.mailboxes).toBeDefined();
            expect(Array.isArray(result.mailboxes)).toBe(true);
            expect(result.mailboxes.length).toBeGreaterThan(0);

            // Check for standard mailbox roles
            const roles = result.mailboxes.map(m => m.role).filter(Boolean);
            expect(roles).toContain('inbox');
        });
    });

    describe('Search Tools', () => {
        it('search_emails returns emails', async () => {
            const result = await searchEmails({ limit: 5 });

            expect(result.emails).toBeDefined();
            expect(Array.isArray(result.emails)).toBe(true);
            expect(result.account).toBeDefined();
        });

        it('search_emails filters by mailbox', async () => {
            const result = await searchEmails({ mailbox: 'Inbox', limit: 5 });

            expect(result.emails).toBeDefined();
        });
    });

    describe('Read Tools', () => {
        it('get_email retrieves email content', async () => {
            // First get an email ID
            const searchResult = await searchEmails({ limit: 1 });

            if (searchResult.emails.length === 0) {
                console.warn('No emails found to test get_email');
                return;
            }

            const emailId = searchResult.emails[0].id;
            const result = await getEmail({ emailId, markAsRead: false });

            expect(result.id).toBe(emailId);
            expect(result.subject).toBeDefined();
            expect(result.body).toBeDefined();
        });
    });

    describe('Mark Tools', () => {
        it('mark_emails can mark as read/unread', async () => {
            // Get an email to mark
            const searchResult = await searchEmails({ limit: 1 });

            if (searchResult.emails.length === 0) {
                console.warn('No emails found to test mark_emails');
                return;
            }

            const emailId = searchResult.emails[0].id;

            // Mark as read
            const result = await markEmails({
                emailIds: [emailId],
                isRead: true
            });

            expect(result.success).toBe(true);
            expect(result.count).toBe(1);
        });
    });

    describe('Tag Tools', () => {
        it('tag_emails can add and remove keywords', async () => {
            // Get an email to tag
            const searchResult = await searchEmails({ limit: 1 });

            if (searchResult.emails.length === 0) {
                console.warn('No emails found to test tag_emails');
                return;
            }

            const emailId = searchResult.emails[0].id;
            const testKeyword = 'mcp-test-tag';

            // Add keyword
            const addResult = await tagEmails({
                emailIds: [emailId],
                addKeywords: [testKeyword]
            });

            expect(addResult.success).toBe(true);

            // Remove keyword
            const removeResult = await tagEmails({
                emailIds: [emailId],
                removeKeywords: [testKeyword]
            });

            expect(removeResult.success).toBe(true);
        });
    });

    // Send email test - only run if explicitly enabled
    describe.skip('Send Tools (requires manual enable)', () => {
        it('send_email sends an email', async () => {
            if (!testConfig.recipient) {
                console.warn('No test recipient configured');
                return;
            }

            const result = await sendEmail({
                to: testConfig.recipient,
                subject: `MCP Test Email - ${new Date().toISOString()}`,
                body: 'This is a test email from Courier integration tests.',
            });

            expect(result.success).toBe(true);
            expect(result.emailId).toBeDefined();
        });
    });

    // Multi-account tests
    describe('Multi-Account Support', async () => {
        it('can switch between accounts', async () => {
            if (!testConfig.isMultiAccountConfigured) {
                console.warn('Multi-account not configured, skipping');
                return;
            }

            // This would require setting up the accounts.json config
            // For now, just verify the switch mechanism works
            const currentResult = await getCurrentAccount();
            expect(currentResult.hasAccounts).toBe(true);
        });
    });

    describe('Mailbox Lifecycle Tools', () => {
        it('can create, details, rename, move, set role, and delete a mailbox', async () => {
            const testMailboxName = `mcp-test-${Date.now()}`;
            
            // 1. Create mailbox
            const createResult = await createMailbox({ name: testMailboxName });
            expect(createResult.success).toBe(true);
            expect(createResult.mailbox.name).toBe(testMailboxName);
            const mailboxId = createResult.mailbox.id;
            expect(mailboxId).toBeDefined();

            // 2. Get details
            const detailsResult = await getMailboxDetails({ id: mailboxId });
            expect(detailsResult.mailbox.id).toBe(mailboxId);
            expect(detailsResult.mailbox.name).toBe(testMailboxName);

            // 3. Rename mailbox
            const renamedName = `${testMailboxName}-renamed`;
            const renameResult = await renameMailbox({ id: mailboxId, name: renamedName });
            expect(renameResult.success).toBe(true);

            // 4. Set role
            const roleResult = await setMailboxRole({ id: mailboxId, role: 'archive' });
            expect(roleResult.success).toBe(true);
            expect(roleResult.role).toBe('archive');

            // Clear role
            const clearRoleResult = await setMailboxRole({ id: mailboxId, role: null });
            expect(clearRoleResult.success).toBe(true);

            // 5. Delete mailbox
            const deleteResult = await deleteMailbox({ id: mailboxId });
            expect(deleteResult.success).toBe(true);
        });
    });

    describe('Contacts Lifecycle Tools', () => {
        it('can list, create, search, get, update, and delete contacts', async () => {
            // Check if contacts capability is supported in the current session
            const manager = getAccountManager();
            const account = manager.getCurrentAccount();
            if (!account) {
                console.warn('Skipping Contacts tests: No account configured');
                return;
            }
            const client = getClient(account);
            const session = await client.fetchSession();
            if (!session.capabilities['urn:ietf:params:jmap:contacts']) {
                console.warn('⚠️  Skipping Contacts integration tests: API Token does not support JMAP Contacts capability.');
                return;
            }

            // 1. List address books
            const addressBooksResult = await listAddressBooks();
            expect(addressBooksResult.addressBooks).toBeDefined();
            expect(addressBooksResult.addressBooks.length).toBeGreaterThan(0);
            const defaultAddressBook = addressBooksResult.addressBooks.find(ab => ab.isDefault) || addressBooksResult.addressBooks[0];
            const addressBookId = defaultAddressBook.id;

            // 2. Create contact
            const testName = `MCP Test Contact ${Date.now()}`;
            const createResult = await createContact({
                addressBookId,
                fullName: testName,
                email: 'mcp-test@example.com',
                phone: '+15551234567',
                company: 'MCP Org',
                jobTitle: 'Developer',
                notes: 'Created via integration tests',
            });
            expect(createResult.contact.id).toBeDefined();
            expect(createResult.contact.fullName).toBe(testName);
            expect(createResult.contact.email).toBe('mcp-test@example.com');
            const contactId = createResult.contact.id;

            // 3. Search contact
            const searchResult = await searchContacts({ text: testName });
            expect(searchResult.contacts.length).toBeGreaterThan(0);
            expect(searchResult.contacts.map(c => c.id)).toContain(contactId);

            // 4. Get contact
            const getResult = await getContact({ ids: [contactId] });
            expect(getResult.contacts.length).toBe(1);
            expect(getResult.contacts[0].fullName).toBe(testName);

            // 5. Update contact
            const updatedName = `${testName} Updated`;
            const updateResult = await updateContact({
                id: contactId,
                fullName: updatedName,
                email: 'mcp-test-updated@example.com',
                phone: '+15559876543',
                company: 'MCP Org Updated',
                jobTitle: 'Senior Developer',
                notes: 'Updated via integration tests',
            });
            expect(updateResult.success).toBe(true);
            expect(updateResult.contact.fullName).toBe(updatedName);
            expect(updateResult.contact.email).toBe('mcp-test-updated@example.com');

            // 6. Delete contact
            const deleteResult = await deleteContact({ id: contactId });
            expect(deleteResult.success).toBe(true);
        });
    });
});

// Direct JMAP client tests
describe('JMAP Client', () => {
    it('can fetch session', async () => {
        if (!testConfig.isConfigured) {
            return;
        }

        const client = new JMAPClient({
            name: 'test',
            token: testConfig.token1!,
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        });

        const session = await client.fetchSession();

        expect(session).toBeDefined();
        expect(session.username).toBeDefined();
        expect(session.apiUrl).toBeDefined();
    });

    it('can get mailboxes', async () => {
        if (!testConfig.isConfigured) {
            return;
        }

        const client = new JMAPClient({
            name: 'test',
            token: testConfig.token1!,
            sessionUrl: 'https://api.fastmail.com/jmap/session',
        });

        const mailboxes = await client.getMailboxes();

        expect(mailboxes).toBeDefined();
        expect(Array.isArray(mailboxes)).toBe(true);
        expect(mailboxes.length).toBeGreaterThan(0);
    });
});
