import { describe, expect, it } from 'vitest';

import { renderLoginPage, renderNoVaultPage, renderUiPage } from '../src/ui.js';

describe('setup UI', () => {
    it('renders a styled OIDC login page', () => {
        const html = renderLoginPage('oidc');

        expect(html).toContain('Courier');
        expect(html).toContain('Continue securely');
        expect(html).toContain('href="/auth/login"');
        expect(html).toContain('Content-Security-Policy');
    });

    it('renders credential inputs as password fields without existing secrets', () => {
        const html = renderUiPage(
            { userId: 'google-oauth2|123', email: 'person@example.com' },
            [{
                name: 'mail@example.com',
                displayName: 'Personal',
                caldav: { password: 'do-not-render', username: 'calendar-user' },
            }],
            'mail@example.com',
            'mail@example.com'
        );

        expect(html).toContain('type="password"');
        expect(html).toContain('person@example.com');
        expect(html).not.toContain('google-oauth2|123');
        expect(html).not.toContain('do-not-render');
        expect(html).toContain('Mail + calendar');
        expect(html).toContain('Default');
        expect(html).toContain('Update account');
        expect(html).toContain('value="mail@example.com" readonly');
        expect(html).toContain('value="Personal"');
        expect(html).toContain('value="calendar-user"');
        expect(html).toContain('type="checkbox" checked');
        expect(html).toContain('href="/ui">Cancel</a>');
        expect(html).toContain('action="/auth/logout"');
        expect(html).toContain('•••••••••••• (stored)');
        expect(html).toContain('No need to re-enter it');
        expect(html.match(/Stored securely/g)).toHaveLength(2);
    });

    it('makes each connected account an edit target without selecting it by default', () => {
        const html = renderUiPage(
            { userId: 'subject', email: 'person@example.com' },
            [{ name: 'mail+work@example.com', displayName: 'Work' }],
            null
        );

        expect(html).toContain('/ui?account=mail%2Bwork%40example.com#account-form');
        expect(html).toContain('Edit account');
        expect(html).toContain('<h2 id="account-form-heading">Add an account</h2>');
        expect(html).not.toContain('value="mail+work@example.com"');
        expect(html).not.toContain('Stored securely');
    });

    it('escapes account and identity values before rendering', () => {
        const html = renderUiPage(
            { userId: 'subject', email: '<script>alert("email")</script>' },
            [{ name: 'mail@example.com', displayName: '<img src=x onerror=alert(1)>' }],
            null
        );

        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('renders actionable configuration states', () => {
        expect(renderLoginPage('proxy')).toContain('Authentication required');
        expect(renderLoginPage('none')).toContain('Setup unavailable');
        expect(renderNoVaultPage()).toContain('Encrypted storage unavailable');
        expect(renderNoVaultPage()).toContain('COURIER_VAULT_KEY');
    });
});
