import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    guardUnknownClient,
    logRegistrationFailures,
    logTokenFailures,
} from '../src/auth/diagnostics.js';
import { renderUnknownClientPage } from '../src/ui.js';

/**
 * Both handlers exist because a failed OAuth exchange used to leave nothing
 * behind. Observed live on 2026-08-03: a Mac client retried a doomed refresh
 * every thirty seconds for half an hour, and the log held only a column of
 * `POST /token -> 400` -- indistinguishable from a client that never connected,
 * and from a server fault.
 */

const servers: Server[] = [];
const warnings: string[] = [];
let warn: ReturnType<typeof vi.spyOn> | undefined;

afterEach(async () => {
    warn?.mockRestore();
    warn = undefined;
    warnings.length = 0;
    await Promise.all(
        servers.splice(0).map(
            (s) =>
                new Promise<void>((resolve) => {
                    s.close(() => resolve());
                })
        )
    );
});

function captureWarnings(): void {
    warn = vi.spyOn(console, 'warn').mockImplementation((line) => {
        warnings.push(String(line));
    });
}

async function serve(app: express.Express): Promise<string> {
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const clientsStore = (known: string[]) =>
    ({
        getClient: async (id: string) =>
            known.includes(id) ? ({ client_id: id } as never) : undefined,
    }) as never;

describe('token failure logging', () => {
    async function tokenServer(): Promise<string> {
        const app = express();
        app.use(express.urlencoded({ extended: false }));
        app.post('/token', logTokenFailures());
        app.post('/token', (req, res) => {
            const body = req.body as { outcome?: string };
            if (body.outcome === 'ok') {
                res.status(200).json({ access_token: 'granted' });
                return;
            }
            res.status(400).json({ error: body.outcome ?? 'invalid_grant' });
        });
        return serve(app);
    }

    const post = (base: string, fields: Record<string, string>) =>
        fetch(`${base}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
        });

    it('names the client and the reason when an exchange fails', async () => {
        captureWarnings();
        const base = await tokenServer();

        await post(base, {
            client_id: 'abc-123',
            grant_type: 'refresh_token',
            outcome: 'invalid_grant',
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('abc-123');
        expect(warnings[0]).toContain('invalid_grant');
        expect(warnings[0]).toContain('grant=refresh_token');
    });

    it('distinguishes an unknown client from an expired grant', async () => {
        // The whole point: these produced identical log lines before.
        captureWarnings();
        const base = await tokenServer();

        await post(base, {
            client_id: 'gone',
            grant_type: 'authorization_code',
            outcome: 'invalid_client',
        });

        expect(warnings[0]).toContain('invalid_client');
        expect(warnings[0]).toContain('grant=authorization_code');
    });

    it('says nothing when the exchange succeeds', async () => {
        // Successful grants are already logged by the provider; repeating them
        // here would double every healthy refresh.
        captureWarnings();
        const base = await tokenServer();

        await post(base, { client_id: 'abc-123', grant_type: 'refresh_token', outcome: 'ok' });

        expect(warnings).toEqual([]);
    });

    it('still logs when the request carries no client_id', async () => {
        captureWarnings();
        const base = await tokenServer();

        await post(base, { outcome: 'invalid_request' });

        expect(warnings[0]).toContain('unnamed');
        expect(warnings[0]).toContain('grant=unspecified');
    });

    it('does not alter the response body', async () => {
        // Wrapping res.json to read the error must not change what the client
        // actually receives.
        captureWarnings();
        const base = await tokenServer();

        const response = await post(base, {
            client_id: 'abc-123',
            grant_type: 'refresh_token',
            outcome: 'ok',
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ access_token: 'granted' });
    });
});

describe('registration failure logging', () => {
    /**
     * Added 2026-09-16. A hosted client was refused at /register and the only
     * trace anywhere was `POST /register -> 400`. Registration had succeeded 103
     * times for other clients, so nothing looked broken -- while the user saw
     * only "error fetching OAuth configuration" and never reached a consent
     * screen, because without a client_id there is no /authorize to reach.
     */
    async function registerAgainst(
        handler: (req: express.Request, res: express.Response) => void,
        body: unknown
    ): Promise<void> {
        captureWarnings();
        const app = express();
        app.use(express.json());
        app.post('/register', logRegistrationFailures(), handler);
        const url = await serve(app);
        await fetch(`${url}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    const reject = (req: express.Request, res: express.Response) => {
        res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: 'redirect_uris is required',
        });
    };

    it('names the reason the registration was refused', async () => {
        await registerAgainst(reject, { client_name: 'ChatGPT' });

        expect(warnings.join('\n')).toContain('invalid_client_metadata');
        expect(warnings.join('\n')).toContain('redirect_uris is required');
    });

    it('names the client, so a refusal can be attributed', async () => {
        await registerAgainst(reject, { client_name: 'ChatGPT' });

        expect(warnings.join('\n')).toContain('ChatGPT');
    });

    it('lists which metadata keys were offered, to show what was missing', async () => {
        // The keys are the diagnostic: a rejection is nearly always a field the
        // client did or did not send.
        await registerAgainst(reject, { client_name: 'X', grant_types: ['authorization_code'] });

        expect(warnings.join('\n')).toMatch(/metadata keys=\[client_name,grant_types\]/);
    });

    it('logs keys but never values, since redirect URIs identify an installation', async () => {
        await registerAgainst(reject, {
            client_name: 'X',
            redirect_uris: ['https://chatgpt.com/connector/oauth/SECRETPATH'],
        });

        expect(warnings.join('\n')).not.toContain('SECRETPATH');
    });

    it('says nothing when registration succeeds', async () => {
        await registerAgainst(
            (_req, res) => res.status(201).json({ client_id: 'abc' }),
            { client_name: 'X', redirect_uris: ['https://example.com/cb'] }
        );

        expect(warnings).toHaveLength(0);
    });

    it('still reports a refusal that carries no error body', async () => {
        await registerAgainst((_req, res) => res.status(400).end(), { client_name: 'X' });

        expect(warnings.join('\n')).toContain('unspecified');
    });
});

describe('unknown client at /authorize', () => {
    async function authorizeServer(known: string[]): Promise<string> {
        const app = express();
        app.get('/authorize', guardUnknownClient(clientsStore(known), renderUnknownClientPage));
        app.get('/authorize', (_req, res) => {
            res.status(200).send('sdk-handled');
        });
        return serve(app);
    }

    it('returns a readable page instead of a JSON error', async () => {
        captureWarnings();
        const base = await authorizeServer(['registered']);

        const response = await fetch(`${base}/authorize?client_id=revoked`, { redirect: 'manual' });
        const body = await response.text();

        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(body).toContain('no longer authorized');
        // The actionable part: clients do not re-register on their own.
        expect(body).toContain('add it again');
    });

    it('does not redirect, even though a redirect_uri was supplied', async () => {
        // Honouring an unvalidated redirect_uri would turn this into an open
        // redirect, so refusing is required rather than merely tidy.
        captureWarnings();
        const base = await authorizeServer([]);

        const response = await fetch(
            `${base}/authorize?client_id=revoked&redirect_uri=${encodeURIComponent('https://evil.example/steal')}`,
            { redirect: 'manual' }
        );

        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
    });

    it('logs the refusal', async () => {
        captureWarnings();
        const base = await authorizeServer([]);

        await fetch(`${base}/authorize?client_id=revoked`);

        expect(warnings[0]).toContain('revoked');
        expect(warnings[0]).toContain('not registered');
    });

    it('passes a registered client through untouched', async () => {
        const base = await authorizeServer(['registered']);

        const response = await fetch(`${base}/authorize?client_id=registered`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('sdk-handled');
    });

    it('defers to the SDK when no client_id is given', async () => {
        // A missing parameter is the SDK's error to report, not ours to guess at.
        const base = await authorizeServer(['registered']);

        const response = await fetch(`${base}/authorize`);

        expect(await response.text()).toBe('sdk-handled');
    });

    it('defers to the SDK when the store throws', async () => {
        // This handler may only improve a response, never decide one.
        const failing = {
            getClient: async () => {
                throw new Error('store offline');
            },
        } as never;
        const app = express();
        app.get('/authorize', guardUnknownClient(failing, renderUnknownClientPage));
        app.get('/authorize', (_req, res) => {
            res.status(200).send('sdk-handled');
        });
        const base = await serve(app);

        const response = await fetch(`${base}/authorize?client_id=anything`);

        expect(await response.text()).toBe('sdk-handled');
    });
});
