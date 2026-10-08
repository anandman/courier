import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AccountManager, type ExtendedMultiAccountConfig } from '../src/account-manager.js';
import { runWithRequestContext } from '../src/request-context.js';
import { sendDraft, sendDraftSchema } from '../src/tools/send.js';
import { tools } from '../src/tools/index.js';
import { OUTWARD_FACING_TOOLS, defaultTierFor } from '../src/policy/tiers.js';

const config: ExtendedMultiAccountConfig = {
    accounts: [{ name: 'me@example.com', displayName: 'Me', token: 't', sessionUrl: 'https://x/jmap/session' }],
    defaultAccount: 'me@example.com',
};

const DRAFT = {
    id: 'draft-1',
    subject: 'Re: Quarterly numbers',
    to: [{ email: 'them@example.com', name: null }],
};

let client: { getEmails: ReturnType<typeof vi.fn>; sendDraft: ReturnType<typeof vi.fn> };

vi.mock('jmap-courier', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, getClient: () => client };
});

beforeEach(() => {
    client = {
        getEmails: vi.fn(async () => [DRAFT]),
        sendDraft: vi.fn(async () => ({ emailId: 'draft-1', submissionId: 'sub-1' })),
    };
});

const run = (params: unknown) => {
    const accountManager = new AccountManager({ initialConfig: config, allowEnv: false, allowConfigFile: false });
    return runWithRequestContext({ accountManager }, () => sendDraft(sendDraftSchema.parse(params)));
};

describe('sending a draft that already exists', () => {
    it('submits the draft by id, composing nothing', async () => {
        const result = await run({ emailId: 'draft-1' });

        expect(client.sendDraft).toHaveBeenCalledWith('draft-1');
        expect(result.sent).toBe(true);
        expect(result.submissionId).toBe('sub-1');
    });

    /**
     * Read before sending, because afterwards the message has moved to Sent and
     * its draft identity is gone -- so a result that said only "sent" could not
     * be checked against what the person thought they were approving.
     */
    it('reports who it went to and what it said', async () => {
        const result = await run({ emailId: 'draft-1' });

        expect(result.to).toEqual(['them@example.com']);
        expect(result.subject).toBe('Re: Quarterly numbers');
    });

    it('says plainly that it cannot be undone', async () => {
        const result = await run({ emailId: 'draft-1' });

        expect(result.message).toMatch(/cannot be undone/);
        expect(result.message).toMatch(/no longer be sent again/);
    });

    it('surfaces a refusal from the server rather than claiming success', async () => {
        client.sendDraft.mockRejectedValue(new Error('is not in Drafts'));

        await expect(run({ emailId: 'draft-1' })).rejects.toThrow(/not in Drafts/);
    });
});

describe('why no idempotency key is needed', () => {
    /**
     * The draft id is already one. Sending moves the message out of Drafts, so
     * a second call with the same id is refused by the client rather than
     * sending twice; and update_draft replaces a draft with a NEW id, so an id
     * captured before a revision cannot send the version nobody reviewed.
     */
    it('takes only an id, with nothing to replay', () => {
        expect(Object.keys(sendDraftSchema.shape)).toEqual(['emailId']);
    });

    it('warns that a stale id is refused rather than sent', () => {
        const description = sendDraftSchema.shape.emailId.description ?? '';

        expect(description).toMatch(/update_draft/);
        expect(description).toMatch(/stale/);
    });
});

describe('how send_draft is governed', () => {
    it('is advertised', () => {
        expect(tools.map((tool) => tool.name)).toContain('send_draft');
    });

    /**
     * Sending is sending, however reviewable the artefact was. It is denied by
     * default and granted per client, exactly like send_email -- the review
     * step makes it a better tool to grant, not a safer one to assume.
     */
    it('is denied by default, like every other way of sending', () => {
        expect(defaultTierFor('send_draft')).toBe('deny');
        expect(OUTWARD_FACING_TOOLS.has('send_draft')).toBe(true);
    });

    it('tells a model to prefer it when a human should see the message', () => {
        const tool = tools.find((candidate) => candidate.name === 'send_draft');

        expect(tool?.description).toMatch(/rather than send_email/);
        expect(tool?.description).toMatch(/IRREVERSIBLE/);
    });
});
