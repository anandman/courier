/**
 * Test setup - loads environment variables from .env.test
 */

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// .env.test holds live Fastmail tokens, so it lives outside the source tree —
// the repo is inside a synced Dropbox folder and .gitignore does not stop that.
const DEFAULT_TEST_ENV_PATH = join(homedir(), '.local', 'state', 'email-courier', '.env.test');

const envPath = [process.env.COURIER_TEST_ENV_FILE, DEFAULT_TEST_ENV_PATH].find(
    (candidate): candidate is string => !!candidate && existsSync(candidate)
);

if (envPath) {
    config({ path: envPath });
} else {
    console.warn(
        `\n⚠️  No .env.test file found. Copy .env.test.example to ${DEFAULT_TEST_ENV_PATH} and configure your test accounts.\n`
    );
}

/**
 * Where the running server keeps its own environment.
 *
 * Read for the vault key only, and only when the key is not already set. The
 * alternative is a second copy of a secret that already exists on this machine,
 * which is precisely what the rest of this project spent its time removing.
 */
const SERVER_ENV_PATH = join(homedir(), '.config', 'email-courier', 'courier.env');

if (!process.env.COURIER_VAULT_KEY && existsSync(SERVER_ENV_PATH)) {
    config({ path: SERVER_ENV_PATH });
}

/**
 * Accounts for the live tests, taken from the vault the server already uses.
 *
 * These tests used to read tokens pasted into .env.test. That made four copies
 * of credentials that exist elsewhere, and every rotation silently reddened the
 * suite -- which is how ten tests spent weeks failing on "API token has been
 * disabled" while looking like a code problem.
 *
 * The vault is the same store the server reads, so a rotation through the
 * settings UI reaches the tests too. It therefore WINS over .env.test, which
 * is the fallback for a machine with no vault -- the other order was tried for
 * about a minute and reproduced the original fault immediately, since a stale
 * file beating a live vault is the whole problem restated.
 */
async function accountsFromVault(): Promise<
    { name: string; token: string; caldav?: { username?: string; password?: string } }[]
> {
    if (!process.env.COURIER_VAULT_KEY) return [];

    try {
        const { createVaultStore } = await import('../src/vault/index.js');
        const vault = createVaultStore();
        const users = await vault.listUsers();

        for (const user of users) {
            const stored = await vault.getUserConfig(user);
            if (stored?.accounts?.length) return stored.accounts as never;
        }
    } catch (error) {
        // Never fatal: a missing or unreadable vault just means these tests
        // skip, exactly as they do without .env.test.
        console.warn(`\n⚠️  Could not read the vault for live tests: ${(error as Error).message}\n`);
    }

    return [];
}

const vaultAccounts = await accountsFromVault();

/** The first account the vault holds, or whatever .env.test named. */
const primary = vaultAccounts[0];
const secondary = vaultAccounts[1];

// Export test config for convenience
export const testConfig = {
    // The vault wins. A credential rotated through the settings UI must reach
    // these tests, and it cannot if a file written months ago outranks it.
    account1: primary?.name || process.env.TEST_ACCOUNT_1,
    token1: primary?.token || process.env.TEST_TOKEN_1,
    account2: secondary?.name || process.env.TEST_ACCOUNT_2,
    token2: secondary?.token || process.env.TEST_TOKEN_2,
    // Deliberately not defaulted from the vault: a test that sends mail should
    // name its recipient explicitly rather than inherit the account's own
    // address and quietly post to the mailbox under test.
    recipient: process.env.TEST_RECIPIENT,

    // CalDAV configuration
    caldavUsername: primary?.caldav?.username || primary?.name || process.env.TEST_CALDAV_USERNAME,
    caldavPassword: primary?.caldav?.password || process.env.TEST_CALDAV_PASSWORD,

    get isConfigured(): boolean {
        return !!(this.account1 && this.token1 && this.recipient);
    },

    get isMultiAccountConfigured(): boolean {
        return !!(this.isConfigured && this.account2 && this.token2);
    },

    get isCalDAVConfigured(): boolean {
        return !!(this.caldavUsername && this.caldavPassword);
    },
};
