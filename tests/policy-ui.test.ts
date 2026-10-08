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
            expect(html, tool.name).toContain(`name="tier.${tool.name}"`);
        }
    });

    /**
     * One form per client, not per tool. Changing five permissions used to be
     * five page loads. The reason for the per-tool form -- not clobbering an
     * edit made elsewhere -- is served by sending what the page was rendered
     * with alongside each control, so the server can skip untouched rows.
     */
    it('saves the whole client in one submission', () => {
        const html = render();
        const forms = html.match(/action="\/ui\/clients\/policy"/g) ?? [];

        expect(forms.length).toBe(1);
        expect(html).toContain('Save permissions');
        expect(html).toContain('Only the ones you changed are written');
    });

    it('sends the rendered value alongside each control, so untouched rows can be skipped', () => {
        const html = render({ policy: { send_email: 'allow' } });

        expect(html).toContain('name="was.send_email" value="allow"');
        expect(html).toContain('name="was.search_emails" value=""');
    });

    it('carries the client id once for the whole form', () => {
        const html = render({ clientId: 'abc123' });
        expect(html).toContain('name="clientId" value="abc123"');
    });

    /**
     * Two clients can share a name -- "Courier CLI" twice is the case that
     * prompted this -- and permissions are per client, so a list you cannot
     * disambiguate is a list you cannot safely act on.
     */
    it('shows the client id, since names are not unique', () => {
        expect(render({ clientId: 'abc123' })).toContain('abc123');
    });

    it('offers all three tiers plus a way back to the default', () => {
        const html = render();

        expect(html).toContain('>Allow<');
        expect(html).toMatch(/>Ask first \(/);
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

    const rowFor = (html: string, tool: string) =>
        new RegExp(`name="tier\\.${tool}"[\\s\\S]*?</select>`).exec(html)?.[0] ?? '';

    it('preselects a tier the user has set', () => {
        expect(rowFor(render({ policy: { send_email: 'allow' } }), 'send_email')).toContain(
            '<option value="allow" selected>'
        );
    });

    it('preselects the default when the user has set nothing', () => {
        expect(rowFor(render(), 'send_email')).toContain('<option value="" selected>');
    });

    /**
     * "Ask first" cannot reach anyone on this transport -- elicitation needs a
     * session and this server builds a fresh one per request. Offering it under
     * a name that promises a prompt would be a setting that silently means
     * something else.
     */
    it('says plainly that Ask first cannot work here', () => {
        const html = render();

        expect(html).toMatch(/Ask first \(unavailable here/);
        expect(html).toMatch(/acts as Block/);
        expect(html).toMatch(/persistent\s+session/);
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
