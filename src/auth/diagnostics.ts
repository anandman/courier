/**
 * Middleware that makes OAuth work with the clients that actually exist:
 * failures that explain themselves, and tolerance for input that is malformed
 * but unambiguous.
 *
 * The SDK's auth router answers a failed exchange with a status and a JSON
 * error, which is correct but leaves nothing in the log. Both handlers here sit
 * in front of the router because it rejects an unknown client before the
 * provider is ever reached -- there is no hook inside the provider that sees
 * these.
 */

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type express from 'express';

/**
 * Logs why a token exchange failed.
 *
 * Without this every failure is the same line -- `POST /token -> 400` --
 * whether the client is unknown, the refresh token expired, or PKCE did not
 * verify. A client looping on a dead registration then looks identical to one
 * that never connected, and to a server fault. Observed live: a Mac client
 * retried a doomed refresh every thirty seconds for half an hour, and the log
 * showed only a column of 400s.
 */
export function logTokenFailures(): express.RequestHandler {
    return (req, res, next) => {
        const body = req.body as Record<string, unknown> | undefined;
        const clientId = typeof body?.client_id === 'string' ? body.client_id : 'unnamed';
        const grantType = typeof body?.grant_type === 'string' ? body.grant_type : 'unspecified';

        // The reason appears in the response body and nowhere else, so capture
        // it as it goes past rather than trying to re-derive it.
        let failure: string | undefined;
        const json = res.json.bind(res);
        res.json = (payload: unknown) => {
            const error = (payload as { error?: unknown } | null)?.error;
            if (typeof error === 'string') failure = error;
            return json(payload);
        };

        res.on('finish', () => {
            if (res.statusCode < 400) return;
            console.warn(
                `[auth] token exchange failed for ${clientId}: ${failure ?? 'unspecified'}` +
                    ` (grant=${grantType}, status=${res.statusCode})`
            );
        });

        next();
    };
}

/**
 * Accepts `redirect_uris` sent as a bare string.
 *
 * RFC 7591 says it is an array, and the SDK rejects a string outright with
 * `invalid_client_metadata`. That refusal is correct and useless: the client
 * gets no client_id, so it never reaches /authorize, so the user sees only a
 * vague connection error with nothing to act on -- and a registration is the
 * one request a client makes exactly once, so there is no retry that behaves
 * differently.
 *
 * A single URI in a string is not ambiguous. Wrapping it costs one line and
 * keeps a client working that would otherwise be permanently unable to connect,
 * which is the whole trade: strictness here buys nothing that the schema does
 * not already enforce on the value itself.
 *
 * Logged when it happens, because a client sending the wrong shape is worth
 * knowing about even when it is tolerated -- and the name, never the URI, since
 * a redirect URI identifies an installation.
 */
export function normalizeRegistrationMetadata(): express.RequestHandler {
    return (req, _res, next) => {
        const body = req.body as Record<string, unknown> | undefined;
        const uris = body?.redirect_uris;

        // An empty string is not a URI. Leave it to fail validation rather than
        // inventing a redirect target the client never asked for.
        if (body && typeof uris === 'string' && uris.trim() !== '') {
            const name = typeof body.client_name === 'string' ? body.client_name : 'unnamed';
            body.redirect_uris = [uris];
            console.warn(
                `[auth] ${JSON.stringify(name)} sent redirect_uris as a string; ` +
                    'wrapped it in an array (RFC 7591 requires an array)'
            );
        }

        next();
    };
}

/**
 * Logs why a dynamic client registration was rejected.
 *
 * `POST /register` is where a new client's whole relationship with the server
 * begins, and a rejection ends it before anything else can happen: no
 * client_id, so no /authorize, so no consent screen, so nothing for the user to
 * even interpret. The client reports something vague -- "error fetching OAuth
 * configuration", "request timeout" -- and the server log said only
 * `POST /register -> 400`.
 *
 * Observed live: a hosted client was refused here and the only evidence
 * anywhere was that single line. Registration had succeeded 103 times for other
 * clients, so nothing looked broken.
 *
 * Logs the failure reason and the metadata keys offered -- keys only. A
 * registration request carries client names and redirect URIs, which identify
 * the user's installation, and this journal has never contained values.
 */
export function logRegistrationFailures(): express.RequestHandler {
    return (req, res, next) => {
        const body = req.body as Record<string, unknown> | undefined;
        const clientName = typeof body?.client_name === 'string' ? body.client_name : 'unnamed';
        const keys = body && typeof body === 'object' ? Object.keys(body).sort() : [];

        let failure: string | undefined;
        let description: string | undefined;
        const json = res.json.bind(res);
        res.json = (payload: unknown) => {
            const error = payload as { error?: unknown; error_description?: unknown } | null;
            if (typeof error?.error === 'string') failure = error.error;
            // Flattened: the SDK returns a pretty-printed Zod issue list, and a
            // multi-line warning is one grep away from looking truncated --
            // which is exactly how it was first misread.
            if (typeof error?.error_description === 'string') {
                description = error.error_description.replace(/\s+/g, ' ').trim();
            }
            return json(payload);
        };

        res.on('finish', () => {
            if (res.statusCode < 400) return;
            console.warn(
                `[auth] registration rejected for ${JSON.stringify(clientName)}: ` +
                    `${failure ?? 'unspecified'}${description ? ` -- ${description}` : ''} ` +
                    `(status=${res.statusCode}, metadata keys=[${keys.join(',')}])`
            );
        });

        next();
    };
}

/**
 * Answers /authorize with a readable page when the client is not registered.
 *
 * This is the one OAuth endpoint a person actually looks at, so an unknown
 * client_id means someone clicked "connect" and is now reading whatever we
 * return. Refusing to redirect is required -- honouring an unvalidated
 * redirect_uri would make this an open redirect -- but a bare
 * `{"error":"invalid_client"}` tells them nothing. The cause is nearly always a
 * client still presenting a registration that was revoked or lost, and clients
 * do not re-register on their own.
 *
 * Anything unexpected falls through to the SDK, which produces the same error
 * it always did. This handler only ever improves a response; it never decides
 * one.
 */
export function guardUnknownClient(
    clientsStore: OAuthRegisteredClientsStore,
    renderPage: () => string
): express.RequestHandler {
    return (req, res, next) => {
        const clientId = req.query.client_id;
        if (typeof clientId !== 'string' || !clientId) {
            next();
            return;
        }

        void Promise.resolve(clientsStore.getClient(clientId))
            .then((client) => {
                if (client) {
                    next();
                    return;
                }
                console.warn(`[auth] authorize refused: client ${clientId} is not registered`);
                res.status(400).type('html').send(renderPage());
            })
            .catch(() => next());
    };
}
