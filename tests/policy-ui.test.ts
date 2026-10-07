import { describe, expect, it } from 'vitest';

import { renderUiPage, type UiClient } from '../src/ui.js';
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS } from '../src/tools/groups.js';
import { tools } from '../src/tools/index.js';

const user = { userId: 'anand@example.com', email: 'anand@example.com' };

function render(client: Partial<UiClient> = {}) {
    return renderUiPage(user, [], null, null, [
        { clientId: 'c1', clientName: 'ChatGPT', promotedAt: Date.now(), ...client },
    ]);
}

describe('per-client permissions in the settings UI', () => {
    it('offers a control for every tool the server has', () => {
        const html = render();

        for (const tool of tools) {
            expect(html, tool.name).toContain(`value="${tool.name}"`);
        }
    });

    it('posts one tool at a time', () => {
        // One form per tool, not one big one. Posting a whole table would
        // overwrite a change made in another tab with whatever this page
        // happened to be showing, and permissions are exactly where a lost
        // write matters.
        const html = render();
        const forms = html.match(/action="\/ui\/clients\/policy"/g) ?? [];

        expect(forms.length).toBe(
            TOOL_GROUPS.reduce((total, group) => total + group.tools.length, 0) +
                ALWAYS_AVAILABLE_TOOLS.length
        );
    });

    it('carries the client id on every control', () => {
        const html = render({ clientId: 'abc123' });
        expect(html).toContain('name="clientId" value="abc123"');
    });

    it('offers all three tiers plus a way back to the default', () => {
        const html = render();

        expect(html).toContain('>Allow<');
        expect(html).toContain('>Ask first<');
        expect(html).toContain('>Block<');
        expect(html).toMatch(/Default \((Allow|Ask first|Block)\)/);
    });

    /**
     * A row reading "Default" says nothing about what actually happens, which
     * is the only thing the person is there to find out. The effective tier is
     * shown next to every control.
     */
    it('states the tier actually in force, not just the setting', () => {
        const html = render();

        expect(html).toContain('tier-allow');
        expect(html).toContain('tier-deny');
    });

    it('preselects a tier the user has set', () => {
        const html = render({ policy: { send_email: 'allow' } });

        // The send_email form should have Allow selected rather than Default.
        const form = /<form class="tool-policy"[\s\S]*?value="send_email"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
        expect(form).toContain('<option value="allow" selected>');
    });

    it('preselects the default when the user has set nothing', () => {
        const form = /<form class="tool-policy"[\s\S]*?value="send_email"[\s\S]*?<\/form>/.exec(render())?.[0] ?? '';
        expect(form).toContain('<option value="" selected>');
    });

    it('says how many tools are restricted, and how many the user chose', () => {
        expect(render()).toMatch(/\d+ of \d+ tools restricted · all at their defaults/);
        expect(render({ policy: { send_email: 'allow' } })).toMatch(/· 1 set by you/);
    });

    it('explains what each tool does in terms of permitting it', () => {
        const html = render();

        expect(html).toContain('sends a message to other people, which cannot be undone');
        expect(html).toContain('only reads');
    });

    it('keeps each client separate', () => {
        const html = renderUiPage(user, [], null, null, [
            { clientId: 'a', clientName: 'ChatGPT', policy: { send_email: 'allow' } },
            { clientId: 'b', clientName: 'Codex' },
        ]);

        expect(html).toContain('name="clientId" value="a"');
        expect(html).toContain('name="clientId" value="b"');
        expect(html).toMatch(/· 1 set by you/);
        expect(html).toMatch(/all at their defaults/);
    });

    it('escapes everything that came from a client', () => {
        const html = render({ clientName: '<img src=x onerror=alert(1)>' });

        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });
});

describe('what the settings UI no longer offers', () => {
    /**
     * The per-user tool-group toggles are gone. They hid whole feature areas
     * from every client at once, which could not express "let the CLI draft but
     * not this chat assistant" and could not stop one client sending without
     * also taking away search.
     */
    it('has no server-wide tool toggles', () => {
        const html = render();

        expect(html).not.toContain('/ui/tools');
        expect(html).not.toContain('Save tool settings');
        expect(html).not.toContain('name="group"');
    });
});
