#!/usr/bin/env node
/**
 * Email Courier
 * 
 * An MCP server providing email, contacts, calendar and task tools over JMAP and CalDAV.
 * Works with Claude CLI, Gemini CLI, and other MCP-compatible clients.
 */

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    mcpAuthRouter,
    createOAuthMetadata,
    getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import express from 'express';

import { CourierClientStore } from './auth/client-store.js';
import {
    guardUnknownClient,
    logRegistrationFailures,
    logTokenFailures,
    normalizeRegistrationMetadata,
} from './auth/diagnostics.js';
import { CourierOAuthProvider } from './auth/oauth-provider.js';
import { TokenService } from './auth/tokens.js';
import { loadOidcProviderConfig, loadOidcUiConfig, parseAllowedUsers, verifyIdToken } from './auth/oidc.js';
import { createProxyAuthMiddleware } from './auth/proxy.js';
import { assertUsableSessionSecret, signSession, verifySession } from './auth/session.js';
import { AccountManager } from './account-manager.js';
import { TOOL_GROUP_IDS } from './tools/groups.js';
import { handleStatelessMcpRequest } from './http-transport.js';
import { createMcpServer } from './mcp-server.js';
import { createVaultStore } from './vault/index.js';
import { describeAddresses } from './net-names.js';
import { runWithPeerAddress, runWithRequestContext } from './request-context.js';
import { createUserAccountManager } from './user-accounts.js';
import {
    renderLoginPage,
    renderNoVaultPage,
    renderUiPage,
    renderUnknownClientPage,
} from './ui.js';

// Main function
function parsePort(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizePath(value: string | undefined): string {
    const path = value?.trim() || '/mcp';
    return path.startsWith('/') ? path : `/${path}`;
}

function parseAllowedHosts(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const allowedHosts = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return allowedHosts.length > 0 ? allowedHosts : undefined;
}

function parseSeconds(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

/**
 * Registered MCP clients are kept beside the vault but in their own file: they
 * churn far more than account configs, and that churn should never rewrite the
 * file holding mail-provider API tokens.
 */
function resolveClientsFilePath(): string {
    const explicit = process.env.MCP_OAUTH_CLIENTS_FILE;
    if (explicit) return resolve(explicit);

    const vaultFile = process.env.COURIER_VAULT_FILE;
    if (vaultFile) return join(dirname(resolve(vaultFile)), 'oauth-clients.json');

    return join(homedir(), '.config', 'email-courier', 'oauth-clients.json');
}

/**
 * Refuses to start when authentication is enabled but no allowlist is set.
 *
 * Every allowlist check is guarded by `allowedUsers && ...`, so an unset or
 * unparsed `MCP_ALLOWED_USERS` short-circuits them all and admits anyone the
 * upstream provider is willing to authenticate. Because that path never errors,
 * a config file that silently failed to load would open the server to the
 * internet with nothing in the logs to show for it. Fail closed instead, and
 * require an explicit opt-in for the legitimate "any authenticated user" case.
 */
export function assertAccessIsRestricted(mode: 'oidc' | 'proxy', allowedUsers?: Set<string>): void {
    if (allowedUsers && allowedUsers.size > 0) return;

    const optOut = process.env.MCP_ALLOW_ANY_AUTHENTICATED_USER;
    if (optOut === 'true' || optOut === '1') {
        console.warn(
            `[auth] MCP_ALLOW_ANY_AUTHENTICATED_USER is set: every identity accepted by the ${mode} provider will be granted access.`
        );
        return;
    }

    throw new Error(
        `MCP_ALLOWED_USERS is required in ${mode} auth mode. Without it every allowlist check is skipped and any identity the provider authenticates would be admitted. ` +
            'Set a comma-separated allowlist, or set MCP_ALLOW_ANY_AUTHENTICATED_USER=true to accept that deliberately.'
    );
}

function parseAuthMode(): 'oidc' | 'proxy' | 'none' {
    const explicit = process.env.MCP_AUTH_MODE?.toLowerCase();
    if (explicit === 'oidc' || explicit === 'proxy' || explicit === 'none') {
        return explicit;
    }
    if (process.env.MCP_AUTH_PROXY_EMAIL_HEADER || process.env.MCP_AUTH_PROXY_SUB_HEADER) {
        return 'proxy';
    }
    if (process.env.MCP_OIDC_ISSUER_URL) {
        return 'oidc';
    }
    return 'none';
}

/**
 * The browser-session signing secret. Falls back to COURIER_VAULT_KEY for
 * deployments predating MCP_UI_SESSION_SECRET; setting the dedicated variable
 * keeps the signing key separate from the vault's encryption key.
 */
function resolveSessionSecret(): string {
    return process.env.MCP_UI_SESSION_SECRET ?? process.env.COURIER_VAULT_KEY ?? '';
}

function parseCookies(headerValue: string | undefined): Record<string, string> {
    if (!headerValue) return {};
    return headerValue.split(';').reduce<Record<string, string>>((acc, pair) => {
        const [rawKey, ...rest] = pair.trim().split('=');
        if (!rawKey) return acc;
        acc[rawKey] = decodeURIComponent(rest.join('='));
        return acc;
    }, {});
}

function setCookie(
    res: express.Response,
    name: string,
    value: string,
    options: { httpOnly?: boolean; secure?: boolean; maxAge?: number; path?: string; sameSite?: 'lax' | 'strict' | 'none' }
) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) {
        parts.push(`Max-Age=${options.maxAge}`);
        if (options.maxAge === 0) {
            parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        }
    }
    parts.push(`Path=${options.path ?? '/'}`);
    if (options.httpOnly) {
        parts.push('HttpOnly');
    }
    if (options.secure) {
        parts.push('Secure');
    }
    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite}`);
    }
    const cookieValue = parts.join('; ');
    const existing = res.getHeader('Set-Cookie');
    if (!existing) {
        res.setHeader('Set-Cookie', cookieValue);
        return;
    }
    if (Array.isArray(existing)) {
        res.setHeader('Set-Cookie', [...existing, cookieValue]);
        return;
    }
    res.setHeader('Set-Cookie', [existing.toString(), cookieValue]);
}

async function startStdioServer() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

async function startHttpServer() {
    const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
    const port = parsePort(process.env.MCP_HTTP_PORT, 3333);
    const path = normalizePath(process.env.MCP_HTTP_PATH);
    const allowedHosts = parseAllowedHosts(process.env.MCP_HTTP_ALLOWED_HOSTS);
    const authMode = parseAuthMode();
    const publicUrlValue = process.env.MCP_PUBLIC_URL ?? `http://${host}:${port}`;
    const publicUrl = new URL(publicUrlValue.endsWith('/') ? publicUrlValue.slice(0, -1) : publicUrlValue);
    const resourceServerUrl = new URL(path, publicUrl);

    const vault = authMode === 'none' ? null : createVaultStore();

    const app = createMcpExpressApp({ host, allowedHosts });

    // Tailscale Funnel proxies from loopback and forwards the caller in
    // X-Forwarded-For. Without this, express-rate-limit sees every public
    // request as coming from 127.0.0.1 and buckets all callers together, so one
    // busy client could rate-limit everyone else. Trusting only the loopback hop
    // keeps a remote caller from spoofing the header to escape its own bucket.
    app.set('trust proxy', 'loopback');

    app.use(express.urlencoded({ extended: false }));

    // Record where each request came from, before the bearer-auth middleware
    // runs: verifyAccessToken stamps the client's last-seen source and is
    // called well before the MCP handler builds the main request context.
    app.use((req, _res, next) => {
        const forwarded = getHeaderValue(req.headers['x-forwarded-for']);
        const source = (forwarded ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        runWithPeerAddress(source || undefined, next);
    });

    // Opt-in access log. Courier sits behind Tailscale Funnel, which keeps no
    // request log of its own, so without this there is no way to tell whether a
    // failing client ever reached the server. Method, path, status and source
    // only — never headers, since Authorization would land in the journal.
    if (process.env.MCP_ACCESS_LOG === '1' || process.env.MCP_ACCESS_LOG === 'true') {
        app.use((req, res, next) => {
            const startedAt = Date.now();
            res.once('finish', () => {
                const forwarded = getHeaderValue(req.headers['x-forwarded-for']);
                const source = forwarded ?? req.socket.remoteAddress ?? '-';
                console.log(
                    `[access] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms src=${source}`
                );
            });
            next();
        });
    }

    app.use((req, res, next) => {
        if (req.path === '/ui' || req.path.startsWith('/auth/')) {
            res.set({
                'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            });
        }
        next();
    });

    let oidcProviderConfig: Awaited<ReturnType<typeof loadOidcProviderConfig>> | null = null;
    let oidcUiConfig: ReturnType<typeof loadOidcUiConfig> | null = null;
    let oauthProvider: CourierOAuthProvider | null = null;
    // Hoisted so the settings UI can list and revoke clients. Only populated in
    // oidc mode; proxy and none modes have no client registry of their own.
    let clientStore: CourierClientStore | null = null;

    if (authMode === 'oidc') {
        oidcProviderConfig = await loadOidcProviderConfig();
        oidcUiConfig = loadOidcUiConfig();
        assertAccessIsRestricted('oidc', oidcProviderConfig.allowedUsers);
        // Check the browser-session secret here, not at first login. Signing
        // throws on a weak secret, and without this the failure would surface
        // as a 500 from /auth/callback long after startup looked healthy.
        assertUsableSessionSecret(resolveSessionSecret());

        // Advertised in protected resource metadata as `resource_documentation`.
        // It previously defaulted to a path on this server that nothing serves,
        // so clients were pointed at a 404. The field is optional in RFC 9728 —
        // better to omit it than to publish a dead link.
        const serviceDocumentationUrl = process.env.MCP_SERVICE_DOCUMENTATION_URL
            ? new URL(process.env.MCP_SERVICE_DOCUMENTATION_URL)
            : undefined;
        const upstreamRedirectUri =
            process.env.MCP_OIDC_MCP_REDIRECT_URI ?? new URL('/auth/mcp/callback', publicUrl).href;

        clientStore = new CourierClientStore({ filePath: resolveClientsFilePath() });

        const provider = new CourierOAuthProvider({
            clientsStore: clientStore,
            tokenService: new TokenService({
                issuer: publicUrl.href,
                audience: resourceServerUrl.href,
                secret:
                    process.env.MCP_TOKEN_SECRET ??
                    process.env.MCP_UI_SESSION_SECRET ??
                    process.env.COURIER_VAULT_KEY ??
                    '',
                accessTokenTtlSeconds: parseSeconds(process.env.MCP_ACCESS_TOKEN_TTL, 3600),
                refreshTokenTtlSeconds: parseSeconds(process.env.MCP_REFRESH_TOKEN_TTL, 30 * 24 * 3600),
            }),
            upstream: oidcProviderConfig,
            upstreamClientId: oidcUiConfig.clientId,
            upstreamClientSecret: oidcUiConfig.clientSecret,
            upstreamRedirectUri,
            upstreamScopes: oidcUiConfig.scopes,
            resourceUrl: resourceServerUrl.href,
            allowedUsers: oidcProviderConfig.allowedUsers,
            userIdClaim: oidcProviderConfig.userIdClaim,
        });
        oauthProvider = provider;

        // Courier is the authorization server for MCP clients: it owns dynamic
        // client registration and issues its own tokens. The upstream identity
        // provider is reached only from the user's browser during login, never
        // from a client, so provider-side client caps or datacenter-IP filtering
        // cannot break a connection.
        // Both sit in front of the SDK router: it rejects an unknown client
        // before the provider is reached, so neither case is visible from
        // inside the provider.
        app.post('/token', logTokenFailures());
        // Normalise before logging, so the log records what was actually
        // rejected rather than what the client originally sent.
        app.post('/register', normalizeRegistrationMetadata(), logRegistrationFailures());
        app.get('/authorize', guardUnknownClient(clientStore, renderUnknownClientPage));

        app.use(
            mcpAuthRouter({
                provider,
                issuerUrl: publicUrl,
                baseUrl: publicUrl,
                resourceServerUrl,
                serviceDocumentationUrl,
            })
        );

        app.get('/auth/mcp/callback', (req, res, next) => {
            provider.handleUpstreamCallback(req, res).catch(next);
        });

        // RFC 8414 puts authorization server metadata at the bare well-known
        // path for an issuer with no path component, and that is where the SDK
        // router serves it. Clients that probe the path-suffixed form first
        // would otherwise get a 404, so serve the same document there too.
        //
        // Deliberately NOT served at /.well-known/openid-configuration. Doing
        // so broke ChatGPT: it fetched the document, found something that
        // announces itself as OIDC discovery but has no jwks_uri,
        // subject_types_supported or id_token_signing_alg_values_supported,
        // and abandoned the connection while holding a valid access token. A
        // 404 there is not a gap — it is what makes a client fall back to the
        // OAuth metadata that actually describes this server. Courier signs
        // HS256 with a shared secret and issues no id_token, so it cannot
        // publish a conformant OIDC document at any point.
        const oauthMetadata = createOAuthMetadata({
            provider,
            issuerUrl: publicUrl,
            baseUrl: publicUrl,
            serviceDocumentationUrl,
        });
        app.get(`/.well-known/oauth-authorization-server${path}`, (_req, res) => {
            res.set('Access-Control-Allow-Origin', '*');
            res.json(oauthMetadata);
        });

        // The SDK router only mounts the path-suffixed PRM document required by
        // RFC 9728. Clients that fall back to probing the bare well-known path
        // (Claude's hosted surfaces do) would otherwise get a 404, so serve the
        // same document there as well.
        const rootProtectedResourceMetadata = {
            resource: resourceServerUrl.href,
            authorization_servers: [publicUrl.href],
            ...(serviceDocumentationUrl ? { resource_documentation: serviceDocumentationUrl.href } : {}),
        };
        app.get('/.well-known/oauth-protected-resource', (_req, res) => {
            res.set('Access-Control-Allow-Origin', '*');
            res.json(rootProtectedResourceMetadata);
        });
    }

    if (authMode === 'proxy') {
        const allowlist = parseAllowedUsers(process.env.MCP_ALLOWED_USERS);
        assertAccessIsRestricted('proxy', allowlist);
        app.use(
            createProxyAuthMiddleware({
                emailHeader: (process.env.MCP_AUTH_PROXY_EMAIL_HEADER ?? 'x-auth-email').toLowerCase(),
                subjectHeader: (process.env.MCP_AUTH_PROXY_SUB_HEADER ?? 'x-auth-user').toLowerCase(),
                allowlist,
                userIdClaim: process.env.MCP_USER_ID_CLAIM ?? 'email',
            })
        );
    }

    const mcpAuthMiddleware =
        authMode === 'oidc' && oauthProvider
            ? requireBearerAuth({
                  verifier: oauthProvider,
                  requiredScopes: oidcProviderConfig?.requiredScopes ?? [],
                  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
              })
            : null;

    app.get('/', (_req, res) => {
        res.redirect('/ui');
    });

    app.get('/auth/login', async (_req, res) => {
        if (authMode !== 'oidc' || !oidcProviderConfig || !oidcUiConfig) {
            res.status(404).send('OIDC not configured');
            return;
        }

        const state = randomBytes(16).toString('hex');
        const codeVerifier = randomBytes(32).toString('hex');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

        const authorizeUrl = new URL(oidcProviderConfig.metadata.authorization_endpoint);
        authorizeUrl.searchParams.set('client_id', oidcUiConfig.clientId);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('redirect_uri', oidcUiConfig.redirectUri);
        authorizeUrl.searchParams.set('scope', oidcUiConfig.scopes.join(' '));
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('prompt', 'login');

        setCookie(res, 'fm_oidc_state', JSON.stringify({ state, codeVerifier }), {
            httpOnly: true,
            secure: publicUrl.protocol === 'https:',
            maxAge: 300,
            sameSite: 'lax',
        });

        res.redirect(authorizeUrl.toString());
    });

    app.get('/auth/callback', async (req, res) => {
        if (authMode !== 'oidc' || !oidcProviderConfig || !oidcUiConfig) {
            res.status(404).send('OIDC not configured');
            return;
        }

        const cookies = parseCookies(req.headers.cookie);
        const statePayload = cookies.fm_oidc_state ? safeJsonParse(cookies.fm_oidc_state) : null;
        const state = typeof statePayload?.state === 'string' ? statePayload.state : null;
        const codeVerifier = typeof statePayload?.codeVerifier === 'string' ? statePayload.codeVerifier : null;

        if (!state || !codeVerifier || req.query.state !== state || typeof req.query.code !== 'string') {
            res.status(400).send('Invalid OAuth state');
            return;
        }

        const tokenResponse = await fetch(oidcProviderConfig.metadata.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: req.query.code,
                redirect_uri: oidcUiConfig.redirectUri,
                client_id: oidcUiConfig.clientId,
                ...(oidcUiConfig.clientSecret ? { client_secret: oidcUiConfig.clientSecret } : {}),
                code_verifier: codeVerifier,
            }),
        });

        if (!tokenResponse.ok) {
            res.status(400).send('Token exchange failed');
            return;
        }

        const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
        const idToken = typeof tokenData.id_token === 'string' ? tokenData.id_token : null;
        if (!idToken) {
            res.status(400).send('Missing id_token');
            return;
        }

        const idClaims = await verifyIdToken(idToken, oidcProviderConfig, oidcUiConfig.clientId);
        const authInfo = { extra: idClaims };
        const userIdClaim = process.env.MCP_USER_ID_CLAIM ?? 'email';
        const userId = resolveUserIdFromAuth(authInfo, userIdClaim);

        if (!userId) {
            res.status(403).send('User claim missing');
            return;
        }

        if (oidcProviderConfig.allowedUsers && !oidcProviderConfig.allowedUsers.has(userId.toLowerCase())) {
            res.status(403).send('User not allowed');
            return;
        }

        const ttlSeconds = Number.parseInt(process.env.MCP_UI_SESSION_TTL ?? '604800', 10);
        const sessionSecret = resolveSessionSecret();
        if (!sessionSecret) {
            res.status(500).send('MCP_UI_SESSION_SECRET is required');
            return;
        }

        const sessionToken = signSession(
            {
                sub: userId,
                email: typeof authInfo.extra?.email === 'string' ? authInfo.extra.email : undefined,
                exp: Math.floor(Date.now() / 1000) + ttlSeconds,
            },
            sessionSecret
        );

        setCookie(res, 'fm_session', sessionToken, {
            httpOnly: true,
            secure: publicUrl.protocol === 'https:',
            maxAge: ttlSeconds,
            sameSite: 'lax',
        });

        setCookie(res, 'fm_oidc_state', '', { maxAge: 0, path: '/' });

        res.redirect('/ui');
    });

    app.post('/auth/logout', (_req, res) => {
        setCookie(res, 'fm_session', '', { maxAge: 0, path: '/' });
        setCookie(res, 'fm_oidc_state', '', { maxAge: 0, path: '/' });
        res.redirect(303, '/ui?signed_out=1');
    });

    app.get('/ui', async (req, res) => {
        const uiUser = resolveUiUser(req, authMode, oidcProviderConfig?.allowedUsers);
        if (!uiUser) {
            res.status(200).send(renderLoginPage(authMode));
            return;
        }

        if (!vault) {
            res.status(200).send(renderNoVaultPage());
            return;
        }

        const manager = await createUserAccountManager(uiUser.userId, vault);
        const accounts = manager.getAccounts();
        const defaultAccount = manager.getCurrentAccountName();
        const requestedAccount =
            typeof req.query.account === 'string' ? req.query.account : null;
        const selectedAccount = accounts.some((account) => account.name === requestedAccount)
            ? requestedAccount
            : null;
        const [clients, unattributed] = clientStore
            ? await Promise.all([
                  clientStore.listClientsForOwner(uiUser.userId),
                  clientStore.listUnattributedClients(),
              ])
            : [[], []];

        // Name the machines. A stored address answers "which machine" only for
        // someone who has memorised their own address plan.
        const names = await describeAddresses(
            [...clients, ...unattributed].map((client) => client.lastSeenFrom)
        );
        const named = (list: typeof clients) =>
            list.map((client) => ({
                ...client,
                lastSeenFrom: client.lastSeenFrom
                    ? (names.get(client.lastSeenFrom) ?? client.lastSeenFrom)
                    : undefined,
            }));

        res.status(200).send(
            renderUiPage(
                uiUser,
                accounts,
                defaultAccount,
                selectedAccount,
                manager.getDisabledToolGroups(),
                named(clients),
                named(unattributed)
            )
        );
    });

    app.post('/ui/clients/revoke', async (req, res) => {
        const uiUser = resolveUiUser(req, authMode, oidcProviderConfig?.allowedUsers);
        if (!uiUser) {
            res.status(401).send('Unauthorized');
            return;
        }

        if (!clientStore) {
            res.status(500).send('Client registry is not configured');
            return;
        }

        const clientId = String(req.body.clientId ?? '').trim();
        if (!clientId) {
            res.status(400).send('clientId is required');
            return;
        }

        const revoked = await clientStore.deleteClient(clientId, uiUser.userId);
        // A failure here is either someone else's client or one that no longer
        // exists, and the two are deliberately indistinguishable to the caller:
        // saying which would confirm the existence of another user's client.
        console.warn(
            `[auth] ${uiUser.userId} revoked client ${clientId}: ${revoked ? 'removed' : 'not found or not theirs'}`
        );

        res.redirect('/ui');
    });

    app.post('/ui/tools', async (req, res) => {
        const uiUser = resolveUiUser(req, authMode, oidcProviderConfig?.allowedUsers);
        if (!uiUser) {
            res.status(401).send('Unauthorized');
            return;
        }

        if (!vault) {
            res.status(500).send('Vault storage is not configured');
            return;
        }

        // Unchecked boxes are simply absent from a form post, so the enabled set
        // is what arrives and the disabled set is everything else. A single
        // checkbox posts a string rather than an array.
        const submitted = req.body.group;
        const enabled = new Set(
            (Array.isArray(submitted) ? submitted : submitted ? [submitted] : []).map(String)
        );
        const disabled = TOOL_GROUP_IDS.filter((id) => !enabled.has(id));

        await vault.updateUserConfig(uiUser.userId, (latestConfig) => {
            const latestManager = new AccountManager({
                initialConfig: latestConfig ?? { accounts: [], defaultAccount: '' },
                allowEnv: false,
                allowConfigFile: false,
            });
            latestManager.setDisabledToolGroups(disabled);
            return latestManager.exportConfig();
        });

        res.redirect('/ui');
    });

    app.post('/ui/account', async (req, res) => {
        const uiUser = resolveUiUser(req, authMode, oidcProviderConfig?.allowedUsers);
        if (!uiUser) {
            res.status(401).send('Unauthorized');
            return;
        }

        const email = String(req.body.email ?? '').trim();
        const token = String(req.body.token ?? '').trim();
        const displayName = String(req.body.displayName ?? '').trim();
        const caldavPassword = String(req.body.caldavPassword ?? '').trim();
        const caldavUsername = String(req.body.caldavUsername ?? '').trim();
        const setDefault = req.body.setDefault === 'on';

        if (!email) {
            res.status(400).send('Email is required');
            return;
        }

        if (!vault) {
            res.status(500).send('Vault storage is not configured');
            return;
        }

        const manager = await createUserAccountManager(uiUser.userId, vault);
        const existing = manager.getAccounts().find((account) => account.name === email);
        const resolvedToken = token || existing?.token;

        if (!resolvedToken) {
            res.status(400).send('API token is required for new accounts');
            return;
        }

        await vault.updateUserConfig(uiUser.userId, (latestConfig) => {
            const latestManager = new AccountManager({
                initialConfig: latestConfig ?? { accounts: [], defaultAccount: '' },
                allowEnv: false,
                allowConfigFile: false,
            });
            const latestExisting = latestManager
                .getAccounts()
                .find((account) => account.name === email);
            const latestToken = token || latestExisting?.token || resolvedToken;

            latestManager.addAccount({
                name: email,
                token: latestToken,
                displayName: displayName || latestExisting?.displayName,
                sessionUrl:
                    latestExisting?.sessionUrl ?? 'https://api.fastmail.com/jmap/session',
                caldav: caldavPassword || latestExisting?.caldav?.password
                    ? {
                          password: caldavPassword || latestExisting?.caldav?.password || '',
                          username:
                              caldavUsername || latestExisting?.caldav?.username || email,
                          serverUrl:
                              latestExisting?.caldav?.serverUrl ??
                              'https://caldav.fastmail.com',
                      }
                    : undefined,
            });
            if (setDefault) {
                latestManager.setDefaultAccount(email);
            }
            return latestManager.exportConfig();
        });

        res.redirect('/ui');
    });

    app.all(path, ...(mcpAuthMiddleware ? [mcpAuthMiddleware] : []), async (req, res) => {
        try {
            const authInfo = req.auth;
            const userIdClaim = process.env.MCP_USER_ID_CLAIM ?? 'email';
            const userId = authInfo ? resolveUserIdFromAuth(authInfo, userIdClaim) : null;
            if (!userId && authMode !== 'none') {
                res.status(401).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Unauthorized' },
                    id: null,
                });
                return;
            }

            const accountManager = userId && vault ? await createUserAccountManager(userId, vault) : undefined;
            await runWithRequestContext({ accountManager, authInfo, userId: userId ?? undefined }, async () => {
                await handleStatelessMcpRequest(req, res);
            });
        } catch (error) {
            if (res.headersSent) {
                res.end();
                return;
            }

            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message,
                },
                id: null,
            });
        }
    });

    app.listen(port, host, () => {
        console.log(`Email Courier listening on http://${host}:${port}${path}`);
    });
}

async function main() {
    const transportMode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

    if (transportMode === 'stdio') {
        await startStdioServer();
        return;
    }

    if (transportMode === 'http' || transportMode === 'streamable-http' || transportMode === 'streamable_http') {
        await startHttpServer();
        return;
    }

    throw new Error(`Unsupported transport mode: ${transportMode}`);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});

function safeJsonParse(value: string): Record<string, unknown> | null {
    try {
        return JSON.parse(value) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function resolveUserIdFromAuth(authInfo: { extra?: Record<string, unknown> }, claim: string): string | null {
    const claimValue = authInfo.extra?.[claim];
    if (typeof claimValue === 'string') return claimValue;
    if (claim === 'email' && typeof authInfo.extra?.email === 'string') return authInfo.extra.email;
    if (claim === 'sub' && typeof authInfo.extra?.sub === 'string') return authInfo.extra.sub;
    if (typeof authInfo.extra?.userId === 'string') return authInfo.extra.userId;
    return null;
}

/**
 * Resolves the signed-in user for a UI request.
 *
 * `allowedUsers` is re-checked here on every request rather than trusted from
 * the cookie. The session is a self-contained signature with a seven-day
 * lifetime and no server-side record, so removing someone from
 * MCP_ALLOWED_USERS used to do nothing at all until their cookie expired: the
 * allowlist was consulted once, at login, and never again. Revocation has to
 * happen on the read path or it does not happen.
 */
export function resolveUiUser(
    req: express.Request,
    authMode: 'oidc' | 'proxy' | 'none',
    allowedUsers?: Set<string>
) {
    // proxy mode needs no check here: createProxyAuthMiddleware enforces the
    // allowlist per request already, since it re-reads the headers every time.
    if (authMode === 'proxy') {
        const authInfo = req.auth;
        const userIdClaim = process.env.MCP_USER_ID_CLAIM ?? 'email';
        const userId = authInfo ? resolveUserIdFromAuth(authInfo, userIdClaim) : null;
        return userId ? { userId } : null;
    }

    if (authMode === 'oidc') {
        const sessionSecret = resolveSessionSecret();
        if (!sessionSecret) {
            return null;
        }
        const cookies = parseCookies(req.headers.cookie);
        const sessionToken = cookies.fm_session;
        if (!sessionToken) return null;
        const session = verifySession(sessionToken, sessionSecret);
        if (!session) return null;
        if (allowedUsers && !allowedUsers.has(session.sub.toLowerCase())) {
            console.warn(
                `[auth] rejecting session for ${session.sub}: no longer in the allowlist`
            );
            return null;
        }
        return { userId: session.sub, email: session.email };
    }

    return { userId: 'local' };
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
    if (!value) return undefined;
    return Array.isArray(value) ? value[0] : value;
}
