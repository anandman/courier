import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    renderLoginPage,
    renderNoVaultPage,
    renderOobCodePage,
    renderOobErrorPage,
    renderUiPage,
} from '../src/ui.js';

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

describe('the out-of-band code page', () => {
    /**
     * Shown to someone finishing a command-line login. It exists because the
     * alternative -- a loopback redirect the browser cannot reach -- renders a
     * browser error page after a *successful* authorization, with the code
     * sitting unexplained in the address bar.
     */
    it('displays the code', () => {
        const html = renderOobCodePage('abc123def456');

        expect(html).toContain('class="code-block"');
        expect(html).toContain('abc123def456');
        expect(html).toContain('Copy this code');
        expect(html).toContain('courier auth login');
    });

    it('says the code is single-use and short-lived', () => {
        // Someone reading a credential off a screen deserves to know what it
        // is worth. PKCE is what makes displaying it safe at all.
        const html = renderOobCodePage('abc');

        expect(html).toMatch(/once/);
        expect(html).toMatch(/five minutes/);
    });

    it('escapes the code rather than trusting it', () => {
        // The code arrives from a query string. It is ours, but it reaches this
        // function through the browser, so it is not trusted here.
        const html = renderOobCodePage('<img src=x onerror=alert(1)>');

        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });

    it('renders an error page when no code was issued', () => {
        const html = renderOobErrorPage('access_denied', 'You declined the request');

        expect(html).toContain('Authorization was not completed');
        expect(html).toContain('access_denied');
        expect(html).toContain('You declined the request');
    });

    it('never shows anything code-shaped on the error page', () => {
        // Folding the two into one page risks displaying an empty or partial
        // code block as though a code had been issued.
        const html = renderOobErrorPage('server_error');

        expect(html).not.toContain('Copy this code');
        // The class itself appears in the shared stylesheet on every page; what
        // must not appear is an element using it.
        expect(html).not.toContain('class="code-block"');
    });

    it('escapes the error it was handed', () => {
        const html = renderOobErrorPage('<script>alert(1)</script>');

        expect(html).not.toContain('<script>alert(1)');
        expect(html).toContain('&lt;script&gt;');
    });
});

describe('the copy button on the code page', () => {
    it('offers one', () => {
        const html = renderOobCodePage('abc123');

        expect(html).toContain('id="copy"');
        expect(html).toContain('Copy code');
    });

    /**
     * The shell's CSP is `default-src 'none'` with no script-src, so an inline
     * script is blocked by default -- which is the point. Allowing it by hash
     * admits exactly these bytes; `'unsafe-inline'` would admit any inline
     * script on the page, including one arriving through a rendering mistake.
     */
    it('allows its script by hash, not by unsafe-inline', () => {
        const html = renderOobCodePage('abc123');

        expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+={0,2}'/);
        expect(html).not.toContain("script-src 'unsafe-inline'");
    });

    it('publishes a hash that matches the script it shipped', () => {
        // A mismatched hash is the worst outcome: the page renders, the button
        // appears, and nothing happens when it is pressed.
        const html = renderOobCodePage('abc123');

        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
        const declared = /script-src 'sha256-([^']+)'/.exec(html)?.[1];
        expect(script).toBeTruthy();
        expect(declared).toBeTruthy();

        const actual = createHash('sha256').update(script!).digest('base64');
        expect(actual).toBe(declared);
    });

    /**
     * The code is read out of the DOM rather than interpolated into a
     * JavaScript string. HTML-escaping does not make a value safe inside a
     * script -- different escaping rules -- and taking it from textContent
     * means there is no JavaScript context to escape from. It also keeps the
     * script's bytes constant, which is what makes the hash stable.
     */
    it('never interpolates the code into the script', () => {
        const html = renderOobCodePage('UNIQUE-CODE-VALUE');

        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
        expect(script).not.toContain('UNIQUE-CODE-VALUE');
        expect(script).toContain('textContent');
    });

    it('keeps the script identical whatever the code is', () => {
        const first = /<script>([\s\S]*?)<\/script>/.exec(renderOobCodePage('aaa'))?.[1];
        const second = /<script>([\s\S]*?)<\/script>/.exec(renderOobCodePage('bbb'))?.[1];

        expect(first).toBe(second);
    });

    it('does not claim to have copied when the clipboard refused', () => {
        // A label reading "Copied" over an empty clipboard sends someone back
        // to the terminal to paste nothing.
        const html = renderOobCodePage('abc123');

        expect(html).toContain('Press Ctrl-C to copy');
    });

    it('ships no script on the error page, which needs none', () => {
        const html = renderOobErrorPage('access_denied');

        expect(html).not.toContain('<script>');
        expect(html).not.toContain('script-src');
    });

    it('leaves the CSP of other pages untouched', () => {
        const html = renderLoginPage('oidc');

        expect(html).not.toContain('script-src');
        expect(html).toContain("default-src 'none'");
    });
});
