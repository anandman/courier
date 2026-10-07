/**
 * OAuth for a command-line client.
 *
 * The point of this file is that nothing in a consumer's config ever holds a
 * mail credential again. The CLI registers itself with Courier over RFC 7591,
 * completes an authorization code flow with PKCE against a loopback redirect,
 * and stores a refresh token. The JMAP token and the DAV app password stay on
 * the server, where exactly one copy of each exists.
 *
 * It is a public client: no client secret, because a secret shipped to every
 * machine that runs a CLI is not a secret. PKCE is what binds the code to this
 * process, and the server requires S256 already.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { CliError, EXIT } from './exit.js';
import { CredentialStore } from './store.js';

/**
 * The redirect URI we register.
 *
 * Deliberately portless. RFC 8252 section 7.3 requires an authorization server
 * to ignore the port when matching a loopback redirect, and the MCP SDK's
 * authorize handler implements that -- so one registration covers whatever
 * ephemeral port the OS hands us at login time. Registering a fixed port
 * instead would make login fail whenever something else held it, and
 * re-registering per port would leave a trail of dead client entries for a
 * human to clean up.
 */
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';

/**
 * Courier's own page that displays the authorization code.
 *
 * Derived from the MCP endpoint's origin because Courier is its own
 * authorization server -- it owns dynamic client registration and issues its
 * own tokens, with the upstream identity provider reached only from the user's
 * browser. The page is Courier's, so its origin is Courier's.
 */
export function oobRedirectFor(serverUrl: string): string {
    return new URL('/auth/oob', serverUrl).href;
}

/** How long to wait for a human to finish signing in. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a stored PKCE verifier stays usable.
 *
 * Matched to the server's authorization window rather than chosen freely: it
 * gives 10 minutes from /authorize to the upstream callback, and the code it
 * issues then lives 5 minutes. A verifier kept beyond 10 minutes could not be
 * exchanged for anything anyway, and in the meantime it is half of a live PKCE
 * pair sitting on disk.
 */
const VERIFIER_TTL_MS = 10 * 60 * 1000;

export interface CliOAuthOptions {
    serverUrl: string;
    store: CredentialStore;
    /** Where the browser will actually land. Absent until the loopback listener is bound. */
    redirectUrl?: string;
    /** Called with the authorization URL instead of launching a browser. */
    onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

/**
 * Both redirect targets this client registers.
 *
 * Registering both up front means switching between the two flows never
 * requires a new registration, which would otherwise strand the old client_id
 * on the server for a human to clean up. The authorization request names which
 * one it is using, as RFC 6749 requires once more than one is registered.
 */
function registeredRedirects(serverUrl: string): string[] {
    return [oobRedirectFor(serverUrl), REGISTERED_REDIRECT];
}

export class CliOAuthProvider implements OAuthClientProvider {
    private readonly options: CliOAuthOptions;
    private readonly store: CredentialStore;
    private stateValue?: string;
    private redirect?: string;

    constructor(options: CliOAuthOptions) {
        this.options = options;
        this.store = options.store;
        this.redirect = options.redirectUrl;
    }

    setRedirectUrl(url: string): void {
        this.redirect = url;
    }

    get redirectUrl(): string {
        // Defaults to Courier's code-display page, which works wherever the
        // browser happens to be. The loopback form is set explicitly by a
        // caller that has bound a listener for it.
        return this.redirect ?? oobRedirectFor(this.options.serverUrl);
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'Courier CLI',
            redirect_uris: registeredRedirects(this.options.serverUrl),
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        };
    }

    async state(): Promise<string> {
        // Generated once per provider instance and remembered, because the
        // callback handler has to compare against the value that was actually
        // sent -- a fresh random each call would make every comparison fail.
        //
        // Also written to the store, because a login can span two separate
        // invocations: one produces the URL, a later one hands back the code.
        // A state held only in the first process could not be checked by the
        // second, and skipping the check there would quietly drop the one
        // protection the parameter exists to provide.
        if (!this.stateValue) {
            this.stateValue = randomBytes(16).toString('base64url');
            await this.store.update(this.options.serverUrl, (current) => ({
                ...current,
                state: this.stateValue,
            }));
        }
        return this.stateValue;
    }

    get expectedState(): string | undefined {
        return this.stateValue;
    }

    /** The state recorded by an earlier invocation, for completing a split login. */
    async storedState(): Promise<string | undefined> {
        return (await this.store.read(this.options.serverUrl)).state;
    }

    async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
        const client = (await this.store.read(this.options.serverUrl)).client;
        if (!client) return undefined;

        // A registration that predates one of the redirect targets cannot be
        // used for that flow: the authorization request would be refused with
        // "Unregistered redirect_uri", which says nothing about why. Treating
        // it as absent makes the next login register afresh, which is the only
        // repair available -- RFC 7591 gives a client no way to amend its own
        // registration, and the SDK's server implements no update endpoint.
        const required = registeredRedirects(this.options.serverUrl);
        const registered = new Set(client.redirect_uris ?? []);
        if (required.some((uri) => !registered.has(uri))) {
            console.warn(
                '[auth] the stored registration predates the code-display redirect; registering again'
            );
            return undefined;
        }

        return client;
    }

    async saveClientInformation(client: OAuthClientInformationFull): Promise<void> {
        await this.store.update(this.options.serverUrl, (current) => ({ ...current, client }));
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        return (await this.store.read(this.options.serverUrl)).tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.store.update(this.options.serverUrl, (current) => ({
            ...current,
            tokens,
            obtainedAt: Date.now(),
            // The verifier is single-use. Keeping it past a successful exchange
            // leaves a usable half of a PKCE pair on disk for no reason.
            codeVerifier: undefined,
            codeVerifierExpiresAt: undefined,
            state: undefined,
        }));
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        await this.store.update(this.options.serverUrl, (current) => ({
            ...current,
            codeVerifier,
            codeVerifierExpiresAt: Date.now() + VERIFIER_TTL_MS,
        }));
    }

    async codeVerifier(): Promise<string> {
        const stored = await this.store.read(this.options.serverUrl);
        if (!stored.codeVerifier) {
            throw new CliError(
                EXIT.AUTH_REJECTED,
                'No PKCE verifier is stored for this server, so the authorization code cannot be exchanged.',
                'Run `courier auth login` again.'
            );
        }

        // Refused, and cleared, once the window has passed. Exchanging against
        // an expired verifier would fail at the server with something far less
        // specific than "your login attempt is too old", and leaving it in
        // place would keep an abandoned attempt looking like a live one.
        if (stored.codeVerifierExpiresAt !== undefined && stored.codeVerifierExpiresAt <= Date.now()) {
            await this.invalidateCredentials('verifier');
            throw new CliError(
                EXIT.AUTH_REJECTED,
                `That login attempt expired; a login must be completed within ${VERIFIER_TTL_MS / 60000} minutes of starting it.`,
                'Run `courier auth login` again to start a fresh one.'
            );
        }

        return stored.codeVerifier;
    }

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
        return (await this.store.read(this.options.serverUrl)).discovery;
    }

    async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
        await this.store.update(this.options.serverUrl, (current) => ({ ...current, discovery }));
    }

    /**
     * Drops whatever the server has told us is no longer valid.
     *
     * Without this a revoked registration is permanent: the SDK would keep
     * presenting a client_id the server has forgotten, and every run would fail
     * identically with nothing to do about it. Clearing lets the next login
     * register afresh.
     */
    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        if (scope === 'all') {
            await this.store.forget(this.options.serverUrl);
            return;
        }
        await this.store.update(this.options.serverUrl, (current) => ({
            ...current,
            client: scope === 'client' ? undefined : current.client,
            tokens: scope === 'tokens' ? undefined : current.tokens,
            obtainedAt: scope === 'tokens' ? undefined : current.obtainedAt,
            codeVerifier: scope === 'verifier' ? undefined : current.codeVerifier,
            codeVerifierExpiresAt: scope === 'verifier' ? undefined : current.codeVerifierExpiresAt,
            state: scope === 'verifier' ? undefined : current.state,
            discovery: scope === 'discovery' ? undefined : current.discovery,
        }));
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        if (this.options.onAuthorizationUrl) {
            await this.options.onAuthorizationUrl(authorizationUrl);
            return;
        }
        openBrowser(authorizationUrl);
    }
}

export interface LoginOptions {
    serverUrl: string;
    store: CredentialStore;
    /**
     * The browser is not on this machine: send it to Courier's code page
     * instead of a loopback port.
     *
     * An assertion by the caller, because nothing can check it. SSH_CONNECTION
     * is absent under mosh, Eternal Terminal and anything else that is not
     * literally ssh, and DISPLAY says only that a screen exists here, not that
     * anyone is at it. A guess that silently picks the wrong flow is worse than
     * a flag.
     *
     * Not needed as often as it looks, because the default accepts a pasted
     * redirect URL as well -- a remote user who lands on a dead 127.0.0.1 page
     * can paste that address and carry on. This flag makes the whole round trip
     * tidy rather than making it possible.
     */
    remote?: boolean;
    /** Print the URL rather than launching a browser. */
    noBrowser?: boolean;
    log: (line: string) => void;
}

export interface LoginResult {
    serverUrl: string;
    clientId?: string;
    authorized: boolean;
    /** Set by `beginLogin`: the URL to open, and the command that finishes the job. */
    authorizationUrl?: string;
}

/**
 * Starts a login without waiting for the redirect, and exits.
 *
 * This is the shape that works when the browser is not on the machine running
 * the CLI -- which is the normal case over SSH, and the case that produced two
 * silent five-minute timeouts before it existed. The loopback listener was
 * bound here on strixhalo while the browser was on another host, so the
 * authorization succeeded, the server issued a code, and the redirect landed on
 * the browser machine's own 127.0.0.1 where nothing was listening. Nothing in
 * either log said so: the server recorded a successful authorization, and the
 * CLI recorded a timeout.
 *
 * Splitting it in two also means the two halves need not share a process, a
 * terminal, or a session -- the PKCE verifier and the state are persisted, so
 * `courier auth login --code ...` can finish the job minutes later.
 */
export async function beginLogin(options: LoginOptions): Promise<LoginResult> {
    const { serverUrl, store, log } = options;
    let authorizationUrl: string | undefined;

    const provider = new CliOAuthProvider({
        serverUrl,
        store,
        onAuthorizationUrl: (url) => {
            authorizationUrl = url.href;
        },
    });

    // Any abandoned attempt left a verifier and a state behind that belong to a
    // code nobody will ever present.
    await provider.invalidateCredentials('verifier');

    const result = await auth(provider, { serverUrl }).catch((error) => {
        throw classifyAuthFailure(error);
    });

    if (result === 'AUTHORIZED') {
        log('Already authorized; refreshed the stored token.');
        const client = await provider.clientInformation();
        return { serverUrl, clientId: client?.client_id, authorized: true };
    }

    if (!authorizationUrl) {
        throw new CliError(EXIT.INTERNAL, 'The OAuth flow produced no authorization URL.');
    }

    log('Open this URL in a browser -- on whichever machine you are at:');
    log('');
    log(`  ${authorizationUrl}`);
    log('');
    log('After signing in, Courier will show you a code. Finish with:');
    log('');
    log('  courier auth login --code "<the-code-it-showed>"');
    log('');

    const client = await provider.clientInformation();
    return { serverUrl, clientId: client?.client_id, authorized: false, authorizationUrl };
}

/**
 * Finishes a login started by `beginLogin`, given the redirect URL or the code.
 *
 * Accepts the whole redirect URL by preference, because that is what the
 * browser shows and it carries the state parameter -- so the check against the
 * state this login issued still happens on a path that never saw the redirect
 * itself. A bare code is accepted, with the state unchecked and that said
 * plainly rather than passed over.
 */
export async function completeLogin(
    options: LoginOptions & { code: string }
): Promise<LoginResult> {
    const { serverUrl, store, log } = options;
    const provider = new CliOAuthProvider({ serverUrl, store });

    const stored = await store.read(serverUrl);
    if (!stored.codeVerifier) {
        throw new CliError(
            EXIT.AUTH_REJECTED,
            `No login is in progress for ${serverUrl}, so there is no PKCE verifier to exchange this code with.`,
            'Start one with `courier auth login`.'
        );
    }

    const code = extractCode(options.code, await provider.storedState(), log);

    const result = await auth(provider, { serverUrl, authorizationCode: code }).catch((error) => {
        throw classifyAuthFailure(error);
    });

    if (result !== 'AUTHORIZED') {
        throw new CliError(
            EXIT.AUTH_REJECTED,
            'The authorization code was accepted but no tokens were stored.'
        );
    }

    const client = await provider.clientInformation();
    return { serverUrl, clientId: client?.client_id, authorized: true };
}

/**
 * Pulls the authorization code out of whatever the user pasted.
 *
 * The state check happens here, against the value persisted when the URL was
 * produced. An authorization code is short-lived and single-use, so the realistic
 * risk is not theft but confusion -- two logins started in different terminals,
 * and the code from one pasted into the other. That would otherwise exchange
 * against the wrong verifier and fail with something unhelpful.
 */
function extractCode(
    pasted: string,
    expectedState: string | undefined,
    log: (line: string) => void
): string {
    const trimmed = pasted.trim();
    if (!trimmed) {
        throw new CliError(EXIT.USAGE, '--code needs the redirect URL or the authorization code.');
    }

    // A bare code is the expected input: Courier's code page displays the code
    // and nothing else, so this is the normal path, not a degraded one.
    //
    // It used to announce that the state parameter could not be checked, which
    // read as a warning about the happy path -- alarming, unactionable, and
    // printed immediately before "Authorized". The check is unavailable here by
    // construction, and PKCE is what binds the code to this process: it is
    // single-use, expires in five minutes, and cannot be exchanged without the
    // verifier that never left this machine.
    if (!trimmed.includes('://')) {
        return trimmed;
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new CliError(EXIT.USAGE, `--code is neither a URL nor a bare code: ${JSON.stringify(trimmed)}`);
    }

    const error = url.searchParams.get('error');
    if (error) {
        const description = url.searchParams.get('error_description');
        throw new CliError(
            EXIT.AUTH_REJECTED,
            `The server refused the authorization: ${error}${description ? ` -- ${description}` : ''}`
        );
    }

    const state = url.searchParams.get('state');
    if (expectedState !== undefined && state !== null && state !== expectedState) {
        throw new CliError(
            EXIT.AUTH_REJECTED,
            'That redirect belongs to a different login attempt: its state does not match the one this machine issued.',
            'Start again with `courier auth login` and use the URL it prints.'
        );
    }

    const code = url.searchParams.get('code');
    if (!code) {
        throw new CliError(EXIT.USAGE, 'That URL carries no authorization code.');
    }
    return code;
}

/**
 * Runs an interactive login and stores the resulting tokens.
 *
 * The default is the one most people want: open a browser here, catch the
 * redirect on a loopback port, store the token. Nothing to copy, nothing to
 * paste. A CLI is normally run on the machine its user is sitting at, and that
 * is the case worth optimising.
 *
 * It is not the only case, and the one failure mode that matters is what
 * happens when the assumption is wrong: the authorization succeeds, the server
 * issues a code, the redirect goes to a loopback port on a machine that is not
 * this one, and the only symptom is this command waiting until it times out --
 * a success in the server's log, a timeout here, and nothing connecting the
 * two. That happened twice.
 *
 * So the wait also accepts a pasted redirect URL. A remote user lands on a
 * browser error page with the code in the address bar, pastes that address, and
 * the login completes. The default is optimistic about where the browser is and
 * recovers when it is wrong, which is a better trade than being pessimistic
 * everywhere -- or than guessing, which cannot be done reliably.
 *
 * `remote` makes that round trip tidy instead of merely possible: the browser
 * goes to Courier's own page, which displays the code to paste.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
    const { serverUrl, store, log } = options;

    // Launched by default: a CLI is usually run on the machine its user is
    // sitting at, and that user expects the browser to open.
    const launchBrowser = options.remote !== true && options.noBrowser !== true;

    const provider = new CliOAuthProvider({
        serverUrl,
        store,
        onAuthorizationUrl: (url) => {
            if (launchBrowser) {
                log('Opening your browser to authorize Courier CLI. If it does not open, visit:');
                openBrowser(url);
            } else {
                log('Open this URL to authorize Courier CLI -- on whichever machine you are at:');
            }
            log('');
            log(`  ${url.href}`);
            log('');
        },
    });

    // Any half-finished previous attempt would otherwise supply a verifier that
    // belongs to a code we are about to replace.
    await provider.invalidateCredentials('verifier');

    // Bound before the URL is shown, so there is no window in which the
    // browser can arrive at a closed port.
    const callback = options.remote ? null : await listenForCallback();
    if (callback) provider.setRedirectUrl(callback.redirectUrl);

    // Without a terminal there is nobody to paste, and prompting would hang an
    // unattended run forever instead of failing.
    const canPrompt = process.stdin.isTTY === true;

    try {
        const first = await auth(provider, { serverUrl }).catch((error) => {
            throw classifyAuthFailure(error);
        });

        if (first === 'AUTHORIZED') {
            // A stored refresh token was still good. Nothing to confirm.
            log('Already authorized; refreshed the stored token.');
            const client = await provider.clientInformation();
            return { serverUrl, clientId: client?.client_id, authorized: true };
        }

        const code = await awaitAuthorizationCode({
            callback,
            canPrompt,
            expectedState: provider.expectedState,
            log,
        });

        const second = await auth(provider, { serverUrl, authorizationCode: code }).catch((error) => {
            throw classifyAuthFailure(error);
        });

        if (second !== 'AUTHORIZED') {
            throw new CliError(
                EXIT.AUTH_REJECTED,
                'The authorization code was accepted but no tokens were stored.'
            );
        }

        const client = await provider.clientInformation();
        return { serverUrl, clientId: client?.client_id, authorized: true };
    } finally {
        await callback?.close();
    }
}

interface AwaitCodeOptions {
    callback: CallbackListener | null;
    canPrompt: boolean;
    expectedState: string | undefined;
    log: (line: string) => void;
}

/**
 * Waits for an authorization code from whichever route delivers one first.
 *
 * `Promise.race` is safe to use with both: it attaches handlers to every input,
 * so a rejection from the losing route after the winner settles is already
 * handled and cannot surface as an unhandled rejection. A rejection that
 * arrives *first* does fail the login, which is what should happen -- a state
 * mismatch or an `error=access_denied` on either route is a real refusal.
 *
 * The timeout applies only when nobody can paste. With a terminal present the
 * wait is open-ended: a person reading a consent screen should not be racing a
 * clock they cannot see, and the PKCE verifier has its own expiry, which is the
 * bound that actually matters.
 */
async function awaitAuthorizationCode(options: AwaitCodeOptions): Promise<string> {
    const { callback, canPrompt, expectedState, log } = options;

    if (!callback && !canPrompt) {
        throw new CliError(
            EXIT.NO_AUTH,
            'There is no way to receive the authorization: no loopback listener, and no terminal to paste into.',
            'Run `courier auth login` to get a URL, then finish with `courier auth login --code "<code>"`.'
        );
    }

    if (callback && !canPrompt) {
        return callback.waitForCode(expectedState, LOGIN_TIMEOUT_MS);
    }

    const prompt = promptForCode(expectedState, log, callback !== null);

    try {
        if (!callback) return await prompt.code;
        return await Promise.race([callback.waitForCode(expectedState, null), prompt.code]);
    } finally {
        prompt.close();
    }
}

interface CallbackListener {
    redirectUrl: string;
    waitForCode(expectedState: string | undefined, timeoutMs: number | null): Promise<string>;
    close(): Promise<void>;
}

/**
 * Binds a loopback listener for the redirect.
 *
 * Bound before the authorization URL is ever shown, so there is no window in
 * which the browser can arrive at a closed port. 127.0.0.1 specifically, not
 * 0.0.0.0: an authorization code is a bearer credential for the few seconds it
 * lives, and nothing outside this machine has any business reaching it.
 */
async function listenForCallback(): Promise<CallbackListener> {
    let settle: ((result: { code?: string; error?: CliError }) => void) | undefined;
    const arrival = new Promise<{ code?: string; error?: CliError }>((resolve) => {
        settle = resolve;
    });

    let expected: string | undefined;

    const server: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
            res.writeHead(404).end('Not found');
            return;
        }

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (error) {
            const description = url.searchParams.get('error_description');
            respond(res, 400, 'Authorization failed', description ?? error);
            settle?.({
                error: new CliError(
                    EXIT.AUTH_REJECTED,
                    `The server refused the authorization: ${error}${description ? ` -- ${description}` : ''}`
                ),
            });
            return;
        }

        if (expected !== undefined && state !== expected) {
            // A mismatch is the one case worth being blunt about: it means this
            // redirect was not the one we initiated.
            respond(res, 400, 'Authorization failed', 'The state parameter did not match this login attempt.');
            settle?.({
                error: new CliError(
                    EXIT.AUTH_REJECTED,
                    'The redirect carried a state value this login attempt did not issue, so it was discarded.'
                ),
            });
            return;
        }

        if (!code) {
            respond(res, 400, 'Authorization failed', 'The redirect carried no authorization code.');
            settle?.({
                error: new CliError(EXIT.AUTH_REJECTED, 'The redirect carried no authorization code.'),
            });
            return;
        }

        respond(res, 200, 'Courier CLI is authorized', 'You can close this tab and return to the terminal.');
        settle?.({ code });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (typeof address === 'string' || address === null) {
        server.close();
        throw new CliError(EXIT.INTERNAL, 'Could not determine the loopback port for the OAuth redirect.');
    }

    return {
        redirectUrl: `http://127.0.0.1:${address.port}/callback`,
        async waitForCode(expectedState, timeoutMs) {
            expected = expectedState;
            // `null` means wait indefinitely, which is correct whenever a human
            // can also paste the redirect: the clock would then be racing the
            // person rather than bounding a dead wait.
            const timeout = timeoutMs === null
                ? new Promise<{ code?: string; error?: CliError }>(() => undefined)
                : new Promise<{ code?: string; error?: CliError }>((resolve) => {
                      const timer = setTimeout(() => {
                          resolve({
                              error: new CliError(
                                  EXIT.NO_AUTH,
                                  `Timed out after ${timeoutMs / 60000} minutes waiting for the browser redirect. Nothing was stored.`,
                                  'Re-run with --remote if your browser is not on this machine.'
                              ),
                          });
                          // Unref so a finished process is never held open by a
                          // timer that no longer matters.
                      }, timeoutMs);
                      timer.unref?.();
                  });

            const result = await Promise.race([arrival, timeout]);
            if (result.error) throw result.error;
            if (!result.code) throw new CliError(EXIT.INTERNAL, 'Callback resolved without a code or an error.');
            return result.code;
        },
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/**
 * Prompts for the redirect URL, and can be cancelled.
 *
 * Cancellable because this runs alongside a loopback listener: when the
 * redirect arrives there instead, the prompt has to stop without rejecting --
 * a rejection after the race has settled is noise, and an open readline would
 * hold the process alive after the login succeeded.
 *
 * Takes the whole URL by preference rather than demanding the bare code,
 * because the whole URL is what the browser shows and it carries the state
 * parameter, so the mismatch check still happens on this route. A bare code is
 * accepted too, with the check skipped and that said plainly.
 */
function promptForCode(
    expectedState: string | undefined,
    log: (line: string) => void,
    alsoListening: boolean
): { code: Promise<string>; close: () => void } {
    if (alsoListening) {
        log('Waiting for your browser to come back.');
        log('');
        log('If your browser is NOT on this machine it will land on a 127.0.0.1 page');
        log('that cannot be reached -- that is expected, and the authorization still');
        log('worked. Paste that address here instead, or press Ctrl-C and re-run with');
        log('--remote for a cleaner round trip.');
    } else {
        log('After signing in, Courier will show you a code. Paste it below.');
    }
    log('');

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const code = new Promise<string>((resolve, reject) => {
        rl.question('Paste here if needed (code, or the full redirect URL): ', (answer) => {
            settled = true;
            try {
                resolve(extractCode(answer, expectedState, log));
            } catch (error) {
                reject(error);
            }
        });

        rl.once('close', () => {
            // Only a failure when nothing was ever entered AND we were not shut
            // down by the other route winning the race.
            if (!settled) {
                settled = true;
                reject(
                    new CliError(
                        EXIT.NO_AUTH,
                        'Input closed before an authorization code was provided. Nothing was stored.'
                    )
                );
            }
        });
    });

    return {
        code,
        close: () => {
            settled = true;
            rl.close();
        },
    };
}

/**
 * Turns a thrown SDK auth failure into an exit code.
 *
 * Discovery and registration both happen inside `auth()`, and they fail for
 * entirely different reasons -- an unreachable host versus a server that
 * refused to register us. Collapsing them would send a caller to re-run a login
 * that cannot work, or to retry a network error forever.
 */
function classifyAuthFailure(error: unknown): CliError {
    if (error instanceof CliError) return error;

    const message = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
    const networkCode = cause?.code ?? (error as { code?: string } | undefined)?.code;

    if (typeof networkCode === 'string' && NETWORK_CODES.has(networkCode)) {
        return new CliError(
            EXIT.UNREACHABLE,
            `Could not reach the server: ${message}`,
            'Check that the server is running and that --server points at it.'
        );
    }
    if (error instanceof TypeError && /fetch failed/i.test(message)) {
        return new CliError(EXIT.UNREACHABLE, `Could not reach the server: ${message}`);
    }

    return new CliError(EXIT.AUTH_REJECTED, `Authorization failed: ${message}`);
}

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function respond(res: ServerResponse, status: number, title: string, detail: string): void {
    const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        '<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}' +
        'h1{font-size:1.25rem}p{color:#444}</style>' +
        `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Best effort browser launch. Never fatal: the URL has already been printed, so
 * a failure here costs the user one copy-paste rather than the login.
 */
function openBrowser(url: URL): void {
    const command = process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'cmd'
          : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url.href] : [url.href];

    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        // Ignored deliberately; see above.
    }
}
