import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import {
    InvalidGrantError,
    InvalidRequestError,
    InvalidTokenError,
    ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { CourierClientStore } from './client-store.js';
import { verifyIdToken, type OidcProviderConfig } from './oidc.js';
import type { TokenService } from './tokens.js';
import { getPeerAddress } from '../request-context.js';

export interface CourierOAuthProviderOptions {
    clientsStore: CourierClientStore;
    tokenService: TokenService;
    upstream: OidcProviderConfig;
    upstreamClientId: string;
    upstreamClientSecret?: string;
    upstreamRedirectUri: string;
    upstreamScopes: string[];
    resourceUrl: string;
    allowedUsers?: Set<string>;
    userIdClaim: string;
}

interface PendingAuthorization {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    clientState?: string;
    scopes: string[];
    upstreamVerifier: string;
    expiresAt: number;
}

interface AuthorizationCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    userId: string;
    email?: string;
    scopes: string[];
    expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
/**
 * How long an issued authorization code stays redeemable.
 *
 * This was 60 seconds, which is ten times tighter than the ten-minute maximum
 * RFC 6749 section 4.1.2 recommends, and it assumed the redirect lands somewhere
 * that redeems immediately. A mobile client does not: ChatGPT's app hands off
 * through a custom URL scheme, so the browser has to reopen the app, which then
 * calls its own backend, which finally calls us. An app switch, a locked screen
 * or a moment's inattention blows past a minute easily.
 *
 * Five minutes is still well inside the recommendation, and shortness was never
 * what made this safe: codes are single-use and consumed *before* validation so
 * a failed attempt cannot be replayed, they are bound to both the client and the
 * redirect_uri, and PKCE S256 is mandatory.
 */
export const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 500;
const MAX_CODES = 500;

export class CourierOAuthProvider implements OAuthServerProvider {
    private readonly pending = new Map<string, PendingAuthorization>();
    private readonly codes = new Map<string, AuthorizationCode>();

    constructor(private readonly options: CourierOAuthProviderOptions) {}

    get clientsStore(): CourierClientStore {
        return this.options.clientsStore;
    }

    /**
     * Begins the flow by handing the user to the upstream identity provider.
     * Courier never sees a credential — the upstream only tells us who logged in.
     */
    async authorize(
        client: OAuthClientInformationFull,
        params: AuthorizationParams,
        res: express.Response
    ): Promise<void> {
        this.assertResourceMatches(params.resource);

        const state = randomBytes(32).toString('hex');
        const upstreamVerifier = randomBytes(32).toString('hex');

        prune(this.pending, MAX_PENDING);
        this.pending.set(state, {
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            clientState: params.state,
            scopes: params.scopes ?? [],
            upstreamVerifier,
            expiresAt: Date.now() + PENDING_TTL_MS,
        });

        const authorizeUrl = new URL(this.options.upstream.metadata.authorization_endpoint);
        authorizeUrl.searchParams.set('client_id', this.options.upstreamClientId);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('redirect_uri', this.options.upstreamRedirectUri);
        authorizeUrl.searchParams.set('scope', this.options.upstreamScopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', challengeFor(upstreamVerifier));
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');

        res.redirect(authorizeUrl.toString());
    }

    /**
     * Handles the upstream provider's redirect, then issues Courier's own
     * authorization code back to the MCP client.
     */
    async handleUpstreamCallback(req: express.Request, res: express.Response): Promise<void> {
        const state = typeof req.query.state === 'string' ? req.query.state : null;
        const pending = state ? this.pending.get(state) : undefined;

        if (!state || !pending || pending.expiresAt <= Date.now()) {
            if (state) this.pending.delete(state);
            res.status(400).send('Authorization request expired or not recognized. Please try connecting again.');
            return;
        }
        this.pending.delete(state);

        if (typeof req.query.error === 'string') {
            redirectWithError(res, pending, req.query.error, stringOrUndefined(req.query.error_description));
            return;
        }

        const code = typeof req.query.code === 'string' ? req.query.code : null;
        if (!code) {
            redirectWithError(res, pending, 'invalid_request', 'Missing authorization code');
            return;
        }

        let userId: string;
        let email: string | undefined;
        try {
            const claims = await this.exchangeUpstreamCode(code, pending.upstreamVerifier);
            const resolved = this.resolveUser(claims);
            userId = resolved.userId;
            email = resolved.email;
        } catch (error) {
            // The user only ever sees a generic access_denied, so without this
            // the actual cause is unrecoverable after the fact.
            console.error(
                '[auth] upstream identity verification failed:',
                error instanceof Error ? error.message : String(error)
            );
            redirectWithError(res, pending, 'access_denied', 'Could not verify your identity with the sign-in provider');
            return;
        }

        const { allowedUsers } = this.options;
        if (allowedUsers && allowedUsers.size > 0 && !allowedUsers.has(userId.toLowerCase())) {
            // Name the identity that was turned away. The provider may sign the
            // user in silently as whichever account it already had (authuser=0),
            // so "which account did it actually use" is the whole question here
            // and the client never surfaces the answer.
            console.warn(`[auth] identity "${userId}" is not in MCP_ALLOWED_USERS`);
            redirectWithError(res, pending, 'access_denied', 'This account is not permitted to use this server');
            return;
        }

        const authorizationCode = randomBytes(32).toString('hex');
        prune(this.codes, MAX_CODES);
        this.codes.set(authorizationCode, {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            userId,
            email,
            scopes: pending.scopes,
            expiresAt: Date.now() + CODE_TTL_MS,
        });

        const target = new URL(pending.redirectUri);
        target.searchParams.set('code', authorizationCode);
        if (pending.clientState) {
            target.searchParams.set('state', pending.clientState);
        }
        // A client that receives this and never returns for a token has either
        // rejected the response or failed to reach us, and the two look
        // identical from here. Record what was actually handed back -- origin,
        // path and parameter shape -- so the next silent failure can be told
        // apart from a malformed redirect. The code itself is withheld: it is a
        // bearer credential until it is redeemed.
        console.warn(
            `[auth] issued authorization code to ${pending.clientId} -> ${target.origin}${target.pathname}` +
                ` (code=${authorizationCode.length} chars, state=${pending.clientState ?? 'ABSENT'})`
        );
        res.redirect(target.toString());
    }

    async challengeForAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string
    ): Promise<string> {
        const entry = this.codes.get(authorizationCode);
        if (!entry || entry.expiresAt <= Date.now()) {
            throw new InvalidGrantError('Authorization code is invalid or has expired');
        }
        // Bind the code to the client that requested it, so a code leaked to one
        // client cannot be redeemed by another.
        if (!matches(entry.clientId, client.client_id)) {
            throw new InvalidGrantError('Authorization code was not issued to this client');
        }
        return entry.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL
    ): Promise<OAuthTokens> {
        const entry = this.codes.get(authorizationCode);
        // Single use: consume before any further validation so a failed attempt
        // cannot be replayed.
        this.codes.delete(authorizationCode);

        if (!entry || entry.expiresAt <= Date.now()) {
            throw new InvalidGrantError('Authorization code is invalid or has expired');
        }
        if (!matches(entry.clientId, client.client_id)) {
            throw new InvalidGrantError('Authorization code was not issued to this client');
        }
        if (redirectUri !== undefined && !matches(entry.redirectUri, redirectUri)) {
            throw new InvalidGrantError('redirect_uri does not match the authorization request');
        }
        this.assertResourceMatches(resource);

        const tokens = await this.options.tokenService.issue({
            userId: entry.userId,
            email: entry.email,
            clientId: entry.clientId,
            scopes: entry.scopes,
        });

        // The client has now proven a real, allowlisted user authorized it, so it
        // graduates from the in-memory registry to durable storage. This is also
        // the only point where Courier knows both the client and the human, so
        // it is where ownership is recorded -- registration is anonymous by
        // RFC 7591, and a token afterwards proves only that someone holds it.
        await this.options.clientsStore.promoteClient(entry.clientId, entry.userId);

        // Naming the grant matters more than it looks. Both grants log an
        // identical `POST /token -> 200`, and reading a refresh as a completed
        // sign-in makes a client look healthier than it is -- it hides the fact
        // that no new authorization has succeeded in days.
        console.log(`[auth] issued tokens to ${entry.clientId} for ${entry.userId} via authorization_code`);

        return tokens as OAuthTokens;
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL
    ): Promise<OAuthTokens> {
        this.assertResourceMatches(resource);

        let verified;
        try {
            verified = await this.options.tokenService.verifyRefreshToken(refreshToken);
        } catch {
            throw new InvalidGrantError('Refresh token is invalid or has expired');
        }

        if (!matches(verified.clientId, client.client_id)) {
            throw new InvalidGrantError('Refresh token was not issued to this client');
        }

        const { allowedUsers } = this.options;
        if (allowedUsers && allowedUsers.size > 0 && !allowedUsers.has(verified.userId.toLowerCase())) {
            throw new InvalidGrantError('This account is no longer permitted to use this server');
        }

        // Narrowing only: a refresh must never grant scopes the original grant lacked.
        const granted = scopes ? scopes.filter((scope) => verified.scopes.includes(scope)) : verified.scopes;

        const tokens = await this.options.tokenService.issue({
            userId: verified.userId,
            email: verified.email,
            clientId: verified.clientId,
            scopes: granted,
        });

        console.log(`[auth] issued tokens to ${verified.clientId} for ${verified.userId} via refresh_token`);

        return tokens as OAuthTokens;
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        // Every rejection here must be an InvalidTokenError. The bearer-auth
        // middleware maps only that to a 401 with WWW-Authenticate, and a 401 is
        // what tells a client its token is stale and to re-run the OAuth flow.
        // Any other error becomes a 500, which clients read as a broken server
        // and retry forever instead of re-authenticating.
        let verified;
        try {
            verified = await this.options.tokenService.verifyAccessToken(token);
        } catch {
            throw new InvalidTokenError('Access token is invalid or has expired');
        }

        const { allowedUsers } = this.options;
        if (allowedUsers && allowedUsers.size > 0 && !allowedUsers.has(verified.userId.toLowerCase())) {
            throw new InvalidTokenError('User not allowed');
        }

        // Access tokens are self-contained, so revoking a client by deleting it
        // would otherwise leave its existing token cryptographically valid until
        // expiry -- up to an hour of access for a client the user has explicitly
        // decided not to trust. Checking the client still exists makes the
        // revoke button mean what it says. The store is already in memory, so
        // this is a map lookup, not I/O.
        if (!(await this.options.clientsStore.getClient(verified.clientId))) {
            throw new InvalidTokenError('Client is no longer authorized');
        }

        // Best-effort liveness stamp so the settings UI can show which clients
        // are actually in use. Never allowed to fail a request.
        void this.options.clientsStore
            .touchClient(verified.clientId, getPeerAddress())
            .catch(() => undefined);

        return {
            token,
            clientId: verified.clientId,
            scopes: verified.scopes,
            expiresAt: verified.expiresAt,
            extra: {
                ...verified.claims,
                sub: verified.userId,
                userId: verified.userId,
                ...(verified.email ? { email: verified.email } : {}),
            },
        };
    }

    private assertResourceMatches(resource?: URL): void {
        if (!resource) return;
        if (!matches(resource.href.replace(/\/$/, ''), this.options.resourceUrl.replace(/\/$/, ''))) {
            throw new InvalidRequestError('resource does not match this server');
        }
    }

    private async exchangeUpstreamCode(code: string, verifier: string): Promise<Record<string, unknown>> {
        const response = await fetch(this.options.upstream.metadata.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.options.upstreamRedirectUri,
                client_id: this.options.upstreamClientId,
                ...(this.options.upstreamClientSecret ? { client_secret: this.options.upstreamClientSecret } : {}),
                code_verifier: verifier,
            }),
        });

        if (!response.ok) {
            throw new ServerError('Upstream token exchange failed');
        }

        const data = (await response.json()) as Record<string, unknown>;
        if (typeof data.id_token !== 'string') {
            throw new ServerError('Upstream response did not include an id_token');
        }

        return verifyIdToken(data.id_token, this.options.upstream, this.options.upstreamClientId);
    }

    private resolveUser(claims: Record<string, unknown>): { userId: string; email?: string } {
        const email = typeof claims.email === 'string' ? claims.email : undefined;
        const claimValue = claims[this.options.userIdClaim];
        const userId = typeof claimValue === 'string' ? claimValue : undefined;

        if (!userId) {
            throw new Error(`Upstream identity is missing the "${this.options.userIdClaim}" claim`);
        }

        return { userId, email };
    }
}

function challengeFor(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

function matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function redirectWithError(
    res: express.Response,
    pending: PendingAuthorization,
    error: string,
    description?: string
): void {
    // Every failure here leaves the same trace as success -- a 302 back to the
    // client -- so without this line an authorization that was refused is
    // indistinguishable in the log from one that was granted. The client shows
    // the user a generic failure and simply never returns for a token.
    console.warn(`[auth] authorization refused for client ${pending.clientId}: ${error}${description ? ` (${description})` : ''}`);

    const target = new URL(pending.redirectUri);
    target.searchParams.set('error', error);
    if (description) {
        target.searchParams.set('error_description', description);
    }
    if (pending.clientState) {
        target.searchParams.set('state', pending.clientState);
    }
    res.redirect(target.toString());
}

/** Drops expired entries, then trims the oldest to keep the map bounded. */
function prune(map: Map<string, { expiresAt: number }>, max: number): void {
    const now = Date.now();
    for (const [key, entry] of map) {
        if (entry.expiresAt <= now) map.delete(key);
    }
    while (map.size >= max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
    }
}

export const __testing = { challengeFor, prune, randomUUID };
