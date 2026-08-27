import { createHmac } from 'node:crypto';

export interface UiSession {
    sub: string;
    email?: string;
    exp: number;
}

function base64UrlEncode(value: Buffer): string {
    return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Buffer {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64');
}

/**
 * Minimum length for the session signing secret, matching the floor
 * `TokenService` enforces on MCP tokens.
 *
 * Node's `createHmac` accepts a key of any length, so nothing here used to
 * object to an eight-character `MCP_UI_SESSION_SECRET` -- it signed real
 * sessions, and the only signal was that the sessions were forgeable. The
 * asymmetry was the danger: MCP tokens refused a weak secret while the browser
 * session, which grants the same access through the settings UI, accepted one.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

export function assertUsableSessionSecret(secret: string): void {
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `Session signing secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
                `(got ${secret.length}). Generate one with: openssl rand -hex 32`
        );
    }
}

export function signSession(session: UiSession, secret: string): string {
    assertUsableSessionSecret(secret);
    const payload = base64UrlEncode(Buffer.from(JSON.stringify(session), 'utf8'));
    const signature = base64UrlEncode(createHmac('sha256', secret).update(payload).digest());
    return `${payload}.${signature}`;
}

export function verifySession(token: string, secret: string): UiSession | null {
    // Fail closed rather than throw: a short secret means no session should
    // ever have been signed with it, and a verifier that threw would turn a
    // misconfiguration into a 500 on every page instead of a login prompt.
    if (secret.length < MIN_SESSION_SECRET_LENGTH) return null;

    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expectedSig = base64UrlEncode(createHmac('sha256', secret).update(payload).digest());
    if (signature !== expectedSig) return null;
    try {
        const session = JSON.parse(base64UrlDecode(payload).toString('utf8')) as UiSession;
        if (typeof session.exp !== 'number' || session.exp < Math.floor(Date.now() / 1000)) {
            return null;
        }
        return session;
    } catch {
        return null;
    }
}
