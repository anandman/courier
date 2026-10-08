import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import {
    createMaskedEmail,
    createMaskedEmailSchema,
    getVacationResponder,
    listMaskedEmails,
    listMaskedEmailsSchema,
    setVacationResponder,
    setVacationResponderSchema,
    updateMaskedEmail,
    updateMaskedEmailSchema,
} from '../src/tools/account-settings.js';
import { OUTWARD_FACING_TOOLS, consequenceOf, defaultTierFor } from '../src/policy/tiers.js';
import { tools } from '../src/tools/index.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'me@example.com',
};

const VACATION = {
    id: 'singleton',
    isEnabled: false,
    fromDate: null,
    toDate: null,
    subject: 'Away',
    textBody: 'Back Monday.',
    htmlBody: null,
    isToContactsOnly: false,
};

const MASKED = [
    { id: 'm1', email: 'a@fastmail.com', state: 'enabled', forDomain: 'shop.example', description: 'Shop', createdAt: '2026-01-01T00:00:00Z', createdBy: '', lastMessageAt: null, url: null },
    { id: 'm2', email: 'b@fastmail.com', state: 'disabled', forDomain: 'news.example', description: '', createdAt: '2026-01-02T00:00:00Z', createdBy: '', lastMessageAt: null, url: null },
    { id: 'm3', email: 'c@fastmail.com', state: 'deleted', forDomain: 'old.example', description: '', createdAt: '2026-01-03T00:00:00Z', createdBy: '', lastMessageAt: null, url: null },
];

let client: Record<string, ReturnType<typeof vi.fn>>;

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

beforeEach(() => {
    client = {
        getVacationResponse: vi.fn(async () => VACATION),
        setVacationResponse: vi.fn(async (patch: Record<string, unknown>) => ({ ...VACATION, ...patch })),
        getMaskedEmails: vi.fn(async () => MASKED),
        createMaskedEmail: vi.fn(async (p: Record<string, unknown>) => ({
            id: 'm9', email: 'new@fastmail.com', state: p.state, forDomain: p.forDomain ?? '', description: p.description ?? '', createdAt: '2026-10-08T00:00:00Z', createdBy: '', lastMessageAt: null, url: null,
        })),
        updateMaskedEmail: vi.fn(async () => undefined),
    };
});

const run = <T>(fn: () => Promise<T>) => {
    const accountManager = new AccountManager({ initialConfig: config, allowEnv: false, allowConfigFile: false });
    return runWithRequestContext({ accountManager }, fn);
};

describe('the auto-reply', () => {
    it('reports its current state', async () => {
        const result = await run(() => getVacationResponder());

        expect(result.isEnabled).toBe(false);
        expect(result.subject).toBe('Away');
        expect(result.body).toBe('Back Monday.');
    });

    /**
     * An auto-reply that is on but answers only contacts looks broken to anyone
     * testing it from an unknown address, and nothing else surfaces the setting.
     */
    it('reports whether it answers only contacts', async () => {
        client.getVacationResponse.mockResolvedValue({ ...VACATION, isToContactsOnly: true });

        expect((await run(() => getVacationResponder())).repliesToContactsOnly).toBe(true);
    });

    it('patches only what was named', async () => {
        await run(() => setVacationResponder(setVacationResponderSchema.parse({ isEnabled: true, subject: 'Out' })));

        expect(client.setVacationResponse).toHaveBeenCalledWith({ isEnabled: true, subject: 'Out' });
    });

    /**
     * Omitting a date leaves it alone; an empty string clears it. Without the
     * distinction there is no way to say "run indefinitely" once an end date
     * has been set.
     */
    it('tells "leave the date alone" apart from "clear it"', async () => {
        await run(() => setVacationResponder(setVacationResponderSchema.parse({ isEnabled: true, toDate: '' })));
        expect(client.setVacationResponse).toHaveBeenCalledWith({ isEnabled: true, toDate: null });

        client.setVacationResponse.mockClear();
        await run(() => setVacationResponder(setVacationResponderSchema.parse({ isEnabled: true })));
        expect(client.setVacationResponse).toHaveBeenCalledWith({ isEnabled: true });
    });

    it('refuses to turn on an empty auto-reply', async () => {
        client.getVacationResponse.mockResolvedValue({ ...VACATION, subject: null, textBody: null });

        await expect(
            run(() => setVacationResponder(setVacationResponderSchema.parse({ isEnabled: true })))
        ).rejects.toThrow(/empty replies/);
        expect(client.setVacationResponse).not.toHaveBeenCalled();
    });

    it('says who will receive it once on', async () => {
        const result = await run(() => setVacationResponder(setVacationResponderSchema.parse({ isEnabled: true, body: 'x' })));

        expect(result.message).toMatch(/Everyone who writes/);
        expect(result.message).toMatch(/until you turn it off/);
    });

    /**
     * Not a single message, which is what makes it worse than sending one: it
     * replies to every stranger, repeatedly, and the person who turned it on is
     * rarely the one who notices.
     */
    it('is denied by default, and counted as outward-facing', () => {
        expect(defaultTierFor('set_vacation_responder')).toBe('deny');
        expect(OUTWARD_FACING_TOOLS.has('set_vacation_responder')).toBe(true);
        expect(consequenceOf('set_vacation_responder')).toMatch(/everyone who writes/);
    });

    it('lets reading it through', () => {
        expect(defaultTierFor('get_vacation_responder')).toBe('allow');
    });
});

describe('masked addresses', () => {
    it('hides retired ones by default', async () => {
        const result = await run(() => listMaskedEmails(listMaskedEmailsSchema.parse({})));

        expect(result.maskedEmails.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    /**
     * A filtered list that reported only its own length would be
     * indistinguishable from the whole set -- including the deleted ones it
     * hides without being asked.
     */
    it('says how many exist, not just how many it returned', async () => {
        const result = await run(() => listMaskedEmails(listMaskedEmailsSchema.parse({ forDomain: 'shop.example' })));

        expect(result.returned).toBe(1);
        expect(result.totalOnAccount).toBe(3);
    });

    it('can ask for retired ones explicitly', async () => {
        const result = await run(() => listMaskedEmails(listMaskedEmailsSchema.parse({ state: 'deleted' })));
        expect(result.maskedEmails.map((m) => m.id)).toEqual(['m3']);
    });

    it('creates an address ready to receive mail', async () => {
        const result = await run(() =>
            createMaskedEmail(createMaskedEmailSchema.parse({ forDomain: 'shop.example', description: 'Shop' }))
        );

        expect(client.createMaskedEmail).toHaveBeenCalledWith({
            forDomain: 'shop.example',
            description: 'Shop',
            state: 'enabled',
        });
        expect(result.email).toBe('new@fastmail.com');
    });

    it('can create one pending instead', async () => {
        await run(() => createMaskedEmail(createMaskedEmailSchema.parse({ enabled: false })));

        expect(client.createMaskedEmail).toHaveBeenCalledWith(
            expect.objectContaining({ state: 'pending' })
        );
    });

    /**
     * Read back rather than echoed, so the result reports what is stored rather
     * than what was asked for.
     */
    it('reports the stored state after a change, not the requested one', async () => {
        client.getMaskedEmails.mockResolvedValue([{ ...MASKED[0], state: 'disabled' }]);

        const result = await run(() => updateMaskedEmail(updateMaskedEmailSchema.parse({ id: 'm1', state: 'disabled' })));

        expect(result.state).toBe('disabled');
        expect(result.message).toMatch(/bounce/);
    });

    it('refuses a change with nothing in it', async () => {
        await expect(
            run(() => updateMaskedEmail(updateMaskedEmailSchema.parse({ id: 'm1' })))
        ).rejects.toThrow(/Nothing to change/);
    });

    it('says so when it cannot confirm the change', async () => {
        client.getMaskedEmails.mockResolvedValue([]);

        await expect(
            run(() => updateMaskedEmail(updateMaskedEmailSchema.parse({ id: 'm1', state: 'enabled' })))
        ).rejects.toThrow(/could not be read back/);
    });

    it('runs by default, being reversible and affecting nothing else', () => {
        expect(defaultTierFor('list_masked_emails')).toBe('allow');
        expect(defaultTierFor('create_masked_email')).toBe('allow');
        expect(defaultTierFor('update_masked_email')).toBe('allow');
    });
});

describe('how the new tools are exposed', () => {
    it('advertises all five', () => {
        const names = tools.map((tool) => tool.name);

        for (const name of ['get_vacation_responder', 'set_vacation_responder', 'list_masked_emails', 'create_masked_email', 'update_masked_email']) {
            expect(names, name).toContain(name);
        }
    });

    it('warns in the auto-reply description that it is outward-facing', () => {
        const tool = tools.find((candidate) => candidate.name === 'set_vacation_responder');
        expect(tool?.description).toMatch(/OUTWARD-FACING/);
    });
});
