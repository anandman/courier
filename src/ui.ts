import { createHash } from 'node:crypto';

import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS } from './tools/groups.js';
import {
    READ_ONLY_TOOLS as ALL_READ_TOOLS,
    TIERS,
    type Tier,
    consequenceOf,
    defaultTierFor,
    tierFor,
} from './policy/tiers.js';

type AuthMode = 'oidc' | 'proxy' | 'none';

export interface UiUser {
    userId: string;
    email?: string;
}

export interface UiAccount {
    name: string;
    displayName?: string;
    caldav?: {
        password: string;
        username?: string;
    };
}

const styles = `
  :root {
    color-scheme: light;
    --ink: #172033;
    --muted: #667085;
    --line: #e5e9f0;
    --panel: rgba(255, 255, 255, 0.94);
    --canvas: #f4f7fb;
    --brand: #3454d1;
    --brand-dark: #243da8;
    --brand-soft: #e9edff;
    --success: #087f5b;
    --success-soft: #e6f7f0;
    --shadow: 0 20px 55px rgba(35, 52, 87, 0.11);
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  * { box-sizing: border-box; }

  /* Per-client permissions. */
  .client-policy {
    margin: 0 0 0.75rem;
    padding: 0 1rem 0.75rem;
    border: 1px solid var(--line);
    border-top: 0;
    border-radius: 0 0 12px 12px;
    background: var(--canvas);
  }

  .client-policy > summary {
    padding: 0.7rem 0;
    cursor: pointer;
    color: var(--brand);
    font-size: 0.85rem;
    font-weight: 650;
  }

  .policy-section { margin: 1rem 0 0; }
  .policy-section h3 { margin: 0; font-size: 0.85rem; }

  .client-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    opacity: 0.65;
  }

  .tool-policy {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--line);
  }

  .tool-policy:last-child { border-bottom: 0; }

  .tool-policy-copy { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
  .tool-policy-copy code { font-size: 0.82rem; font-weight: 650; }
  .tool-policy-copy span { color: var(--muted); font-size: 0.78rem; }

  .tool-policy-controls { display: flex; gap: 0.5rem; align-items: center; }
  .tool-policy-controls select {
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    font: inherit;
    font-size: 0.8rem;
  }
  .tool-policy-controls .button { min-height: 32px; padding: 0 0.7rem; }

  /*
   * The effective tier, stated next to every control. Without it a row reading
   * "Default" says nothing about what actually happens -- which is the only
   * thing the person is there to find out.
   */
  .badge.tier-allow { background: var(--success-soft); color: var(--success); }
  .badge.tier-confirm { background: #fff8e8; color: #7a4d00; }
  .badge.tier-deny { background: #fdeaea; color: #a52020; }

  /*
   * The code page stacks elements that carry no margin of their own -- a
   * <pre> and a <button> -- so they sat flush against the notice below them.
   * Every other card gets its rhythm from <p> defaults, which is fine until a
   * page has no paragraphs between its parts.
   *
   * Laying this one out as a column with an explicit gap spaces every child
   * identically, whatever tags it is built from, instead of hanging the layout
   * on which elements happen to have browser defaults.
   */
  .center-card.oob {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }

  .center-card.oob > * { margin: 0; }

  .center-card.oob .code-block,
  .center-card.oob .notice { width: 100%; }

  /* A command name reads badly when broken across a line. */
  .center-card.oob code { white-space: nowrap; }

  /*
   * The authorization code on the out-of-band page. Monospaced and wrapping,
   * because it is long, and a code that a person has to copy by hand must not
   * be truncated or re-flowed in a way that loses a character.
   */
  .code-block {
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--canvas);
    color: var(--ink);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.95rem;
    line-height: 1.5;
    text-align: left;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    user-select: all;
  }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    background:
      radial-gradient(circle at 12% 5%, rgba(52, 84, 209, 0.13), transparent 28rem),
      radial-gradient(circle at 92% 12%, rgba(99, 182, 255, 0.16), transparent 25rem),
      var(--canvas);
  }

  button, input { font: inherit; }

  a { color: inherit; }

  .shell {
    width: min(1120px, calc(100% - 32px));
    margin: 0 auto;
    padding: 28px 0 56px;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 28px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 13px;
    min-width: 0;
  }

  .brand-mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
    color: white;
    border-radius: 14px;
    background: linear-gradient(145deg, #4968e8, #263da9);
    box-shadow: 0 9px 24px rgba(52, 84, 209, 0.27);
  }

  .brand-mark svg { width: 24px; height: 24px; }

  .brand-copy { min-width: 0; }

  .brand-name {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 750;
    letter-spacing: -0.01em;
  }

  .brand-tagline {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 0.82rem;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 8px 12px 8px 8px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.78);
  }

  .identity-dot {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    color: var(--success);
    border-radius: 50%;
    background: var(--success-soft);
  }

  .identity-dot svg { width: 15px; height: 15px; }

  .identity-copy {
    min-width: 0;
    line-height: 1.15;
  }

  .identity-label {
    display: block;
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .identity-value {
    display: block;
    max-width: 260px;
    margin-top: 2px;
    overflow: hidden;
    font-size: 0.82rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hero {
    position: relative;
    overflow: hidden;
    padding: 38px 40px;
    border-radius: 24px;
    color: white;
    background: linear-gradient(125deg, #172960 0%, #304ec6 62%, #5686ef 100%);
    box-shadow: var(--shadow);
  }

  .hero::after {
    content: "";
    position: absolute;
    width: 250px;
    height: 250px;
    right: -55px;
    bottom: -130px;
    border: 48px solid rgba(255, 255, 255, 0.09);
    border-radius: 50%;
  }

  .eyebrow {
    margin: 0 0 10px;
    color: rgba(255, 255, 255, 0.72);
    font-size: 0.73rem;
    font-weight: 750;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  .hero h1 {
    position: relative;
    z-index: 1;
    max-width: 690px;
    margin: 0;
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.04;
    letter-spacing: -0.04em;
  }

  .hero p:last-child {
    position: relative;
    z-index: 1;
    max-width: 640px;
    margin: 16px 0 0;
    color: rgba(255, 255, 255, 0.79);
    font-size: 1rem;
    line-height: 1.65;
  }

  .content-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(360px, 1.1fr);
    gap: 24px;
    margin-top: 24px;
    align-items: start;
  }

  .card {
    padding: 26px;
    border: 1px solid rgba(218, 224, 235, 0.9);
    border-radius: 20px;
    background: var(--panel);
    box-shadow: 0 12px 35px rgba(45, 61, 94, 0.07);
    backdrop-filter: blur(14px);
  }

  .clients-card {
    margin-top: 24px;
  }

  .client-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 18px;
  }

  .client {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    border: 1px solid rgba(218, 224, 235, 0.9);
    border-radius: 14px;
  }

  .client-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .client-name { font-weight: 600; }

  .client-meta {
    font-size: 13px;
    color: var(--muted);
  }

  .unattributed-note {
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 12px;
  }

  .button.danger {
    border-color: rgba(190, 60, 60, 0.35);
    color: #a52b2b;
    background: rgba(190, 60, 60, 0.06);
    flex: none;
  }

  .button.danger:hover {
    background: rgba(190, 60, 60, 0.12);
  }

  .advanced {
    margin-top: 24px;
  }

  .advanced > summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    list-style: none;
  }

  .advanced > summary::-webkit-details-marker { display: none; }

  .advanced > summary::before {
    content: '';
    width: 7px;
    height: 7px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    transform: rotate(-45deg);
    transition: transform 120ms ease;
    flex: none;
  }

  .advanced[open] > summary::before { transform: rotate(45deg); }

  .advanced > summary .card-intro { display: block; margin-top: 2px; }

  .advanced > form { margin-top: 20px; }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 20px;
  }

  .card h2 {
    margin: 0;
    font-size: 1.16rem;
    letter-spacing: -0.02em;
  }

  .card-intro {
    margin: 5px 0 0;
    color: var(--muted);
    font-size: 0.86rem;
    line-height: 1.5;
  }

  .count {
    min-width: 32px;
    padding: 5px 9px;
    color: var(--brand);
    border-radius: 999px;
    background: var(--brand-soft);
    font-size: 0.78rem;
    font-weight: 750;
    text-align: center;
  }

  .account-list {
    display: grid;
    gap: 12px;
  }

  .account {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 15px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: white;
    text-decoration: none;
    transition: border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
  }

  .account:hover {
    border-color: #bcc7ea;
    box-shadow: 0 8px 22px rgba(35, 52, 87, 0.08);
    transform: translateY(-1px);
  }

  .account:focus-visible {
    outline: 3px solid rgba(52, 84, 209, 0.24);
    outline-offset: 2px;
  }

  .account.selected {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px var(--brand-soft);
  }

  .account-main { min-width: 0; }

  .account-name {
    display: block;
    overflow: hidden;
    font-size: 0.92rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-email {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    color: var(--muted);
    font-size: 0.78rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badges {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
  }

  .account-actions {
    display: grid;
    justify-items: end;
    gap: 8px;
  }

  .edit-account {
    color: var(--brand);
    font-size: 0.73rem;
    font-weight: 750;
  }

  .badge {
    padding: 5px 8px;
    color: #4a5568;
    border-radius: 999px;
    background: #f0f3f8;
    font-size: 0.68rem;
    font-weight: 750;
    white-space: nowrap;
  }

  .badge.default {
    color: var(--success);
    background: var(--success-soft);
  }

  .empty {
    padding: 30px 18px;
    border: 1px dashed #ccd4e1;
    border-radius: 16px;
    text-align: center;
    background: rgba(247, 249, 252, 0.7);
  }

  .empty-icon {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    margin: 0 auto 12px;
    color: var(--brand);
    border-radius: 13px;
    background: var(--brand-soft);
  }

  .empty-icon svg { width: 21px; height: 21px; }

  .empty strong { display: block; font-size: 0.9rem; }

  .empty p {
    margin: 6px auto 0;
    max-width: 300px;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 17px;
  }

  .field { min-width: 0; }
  .field.full { grid-column: 1 / -1; }

  .field label {
    display: block;
    margin-bottom: 7px;
    font-size: 0.78rem;
    font-weight: 720;
  }

  .field-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .field-label label { margin-bottom: 7px; }

  .credential-status {
    margin-bottom: 7px;
    color: var(--success);
    font-size: 0.7rem;
    font-weight: 750;
  }

  .field input[type="email"],
  .field input[type="text"],
  .field input[type="password"] {
    width: 100%;
    height: 43px;
    padding: 0 12px;
    color: var(--ink);
    border: 1px solid #cfd6e2;
    border-radius: 10px;
    outline: none;
    background: white;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .field input:focus {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px rgba(52, 84, 209, 0.12);
  }

  .field input::placeholder { color: #a0a9b8; }

  .hint {
    display: block;
    margin-top: 6px;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.4;
  }

  .checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    grid-column: 1 / -1;
    padding: 12px 13px;
    border-radius: 11px;
    background: #f7f8fb;
  }

  .checkbox-row input {
    width: 17px;
    height: 17px;
    margin: 1px 0 0;
    accent-color: var(--brand);
  }

  .checkbox-copy label {
    display: block;
    font-size: 0.79rem;
    font-weight: 720;
  }

  .checkbox-copy span {
    display: block;
    margin-top: 3px;
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.4;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-top: 22px;
  }

  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 42px;
    padding: 0 16px;
    border: 0;
    border-radius: 10px;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 750;
    text-decoration: none;
  }

  .button svg { width: 15px; height: 15px; }

  .button.primary {
    color: white;
    background: var(--brand);
    box-shadow: 0 7px 16px rgba(52, 84, 209, 0.22);
  }

  .button.primary:hover { background: var(--brand-dark); }

  .button.secondary {
    color: #4b5565;
    border: 1px solid var(--line);
    background: white;
  }

  .button.secondary:hover { background: #f7f8fb; }

  .footer-note {
    margin: 22px 0 0;
    color: #7b8493;
    font-size: 0.7rem;
    line-height: 1.5;
    text-align: center;
  }

  .center-card {
    width: min(520px, calc(100% - 32px));
    margin: 10vh auto 0;
    padding: 34px;
    border: 1px solid var(--line);
    border-radius: 22px;
    background: var(--panel);
    box-shadow: var(--shadow);
    text-align: center;
  }

  .center-card .brand-mark { margin: 0 auto 20px; }

  .center-card h1 {
    margin: 0;
    font-size: 1.7rem;
    letter-spacing: -0.035em;
  }

  .center-card p {
    margin: 12px auto 22px;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .notice {
    padding: 12px 14px;
    color: #7a4d00;
    border: 1px solid #f1d49c;
    border-radius: 11px;
    background: #fff8e8;
    font-size: 0.8rem;
    line-height: 1.5;
    text-align: left;
  }

  @media (max-width: 780px) {
    .shell { width: min(100% - 22px, 620px); padding-top: 18px; }
    .topbar { align-items: flex-start; }
    .identity-label { display: none; }
    .identity-value { max-width: 150px; margin: 0; }
    .hero { padding: 30px 24px; border-radius: 20px; }
    .content-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 520px) {
    .brand-tagline { display: none; }
    .identity-copy { display: none; }
    .identity { padding-right: 8px; }
    .hero { padding: 26px 20px; }
    .card { padding: 21px 18px; }
    .form-grid { grid-template-columns: 1fr; }
    .field.full, .checkbox-row { grid-column: auto; }
    .actions { align-items: stretch; flex-direction: column; }
    .actions .button, .actions form, .actions form button { width: 100%; }
  }
`;

const envelopeIcon = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.5 6.75h15v10.5h-15V6.75Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="m5.25 7.5 6.75 5.25 6.75-5.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

/** Two overlapping sheets: the conventional copy glyph. */
const copyIcon = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="9" y="9" width="11" height="11" rx="2" />
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
</svg>`;

const checkIcon = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6.5 12.25 3.25 3.25 7.75-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        const entities: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        };
        return entities[character] ?? character;
    });
}

const BASE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * @param script Inline script to include, allowed by its own SHA-256 hash.
 *
 * Hashed rather than permitted wholesale: `script-src 'unsafe-inline'` would
 * admit any inline script on the page, including one injected through a
 * rendering mistake, which is exactly what `default-src 'none'` is here to
 * prevent. A hash admits precisely these bytes and nothing else, so adding
 * behaviour to one page costs nothing on the others.
 */
function documentShell(title: string, body: string, script?: string): string {
    const csp = script
        ? `${BASE_CSP}; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`
        : BASE_CSP;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#263da9" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>${escapeHtml(title)}</title>
    <style>${styles}</style>
  </head>
  <body>${body}${script ? `<script>${script}</script>` : ''}</body>
</html>`;
}

function brandMark(): string {
    return `<span class="brand-mark">${envelopeIcon}</span>`;
}

function centerPage(title: string, message: string, action = ''): string {
    return documentShell(
        title,
        `<main class="center-card">
          ${brandMark()}
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          ${action}
        </main>`
    );
}

export function renderLoginPage(authMode: AuthMode): string {
    if (authMode === 'proxy') {
        return documentShell(
            'Courier',
            `<main class="center-card">
              ${brandMark()}
              <h1>Authentication required</h1>
              <p>The trusted proxy did not provide the identity headers Courier needs.</p>
              <div class="notice">Check the proxy authentication configuration, then reload this page.</div>
            </main>`
        );
    }

    if (authMode === 'oidc') {
        return centerPage(
            'Courier',
            'Connect and manage the accounts available to your private MCP service.',
            `<a class="button primary" href="/auth/login">
              ${checkIcon}
              Continue securely
            </a>`
        );
    }

    return documentShell(
        'Courier',
        `<main class="center-card">
          ${brandMark()}
          <h1>Setup unavailable</h1>
          <p>Courier is running without an authentication provider.</p>
          <div class="notice">Configure OIDC or trusted-proxy authentication before using the setup UI.</div>
        </main>`
    );
}

/**
 * Shown at /authorize when the client is not registered here.
 *
 * This response is rendered in a browser, because /authorize is the one OAuth
 * endpoint a person actually looks at. Refusing to redirect is required -- an
 * unvalidated redirect_uri must never be honoured, or the endpoint becomes an
 * open redirect -- but the SDK's bare `{"error":"invalid_client"}` gives the
 * person staring at it nothing to act on. The cause is almost always a client
 * still presenting a client_id that was revoked or lost, and clients do not
 * re-register on their own, so say what to do about it.
 */
export function renderUnknownClientPage(): string {
    return documentShell(
        'Courier',
        `<main class="center-card">
          ${brandMark()}
          <h1>This application is no longer authorized</h1>
          <p>It is asking for access using a registration Courier does not recognize — usually because that authorization was revoked, or the server's client registry was reset.</p>
          <div class="notice">
            <strong>To reconnect:</strong> remove Courier from the application's
            settings, then add it again. The application will register itself afresh.
            Some apps cache the old registration until they are fully restarted.
          </div>
          <p><a href="/ui">Review your authorized applications</a></p>
        </main>`
    );
}

/**
 * Shown to a person finishing a command-line login: displays the
 * authorization code for them to copy back.
 *
 * This is the out-of-band redirect target, and it exists because the
 * alternative is worse in a specific way. A CLI normally catches its redirect
 * on a loopback port, which works only when the browser is on the same machine
 * as the CLI. When it is not -- the usual case for a server -- the browser
 * lands on a `127.0.0.1` address that refuses the connection, and the person
 * sees a browser error page after a successful authorization. The code is
 * sitting in the address bar, but nothing says so, and every signal on screen
 * says something broke.
 *
 * So the server renders it instead. The flow becomes the one people already
 * know from other tools: sign in, land on a page that shows a code, paste it
 * back.
 *
 * Safe to display because of PKCE, which Courier requires. The code is
 * single-use, expires in five minutes, and can only be exchanged by a client
 * holding the verifier whose hash was sent with the authorization request --
 * which never leaves the machine running the CLI. A code read off this screen
 * by someone else buys them nothing.
 *
 * The caller is responsible for `Cache-Control: no-store` and a referrer
 * policy; this function only renders.
 */
export function renderOobCodePage(code: string): string {
    return documentShell(
        'Courier',
        `<main class="center-card oob">
          ${brandMark()}
          <h1>Copy this code</h1>
          <p>Paste it back into the terminal where you started <code>courier auth login</code>.</p>
          <pre class="code-block" id="code">${escapeHtml(code)}</pre>
          <button class="button primary" id="copy" type="button">${copyIcon}<span id="copy-label">Copy code</span></button>
          <div class="notice">
            This code can be used once, expires in five minutes, and is useless
            to anyone but the command that requested it.
          </div>
        </main>`,
        COPY_SCRIPT
    );
}

/**
 * The copy button's behaviour.
 *
 * Reads the code out of the DOM instead of having it interpolated into a
 * JavaScript string literal. The code is ours, but it arrives here through a
 * query string, and HTML-escaping it does not make it safe inside a script --
 * those are different escaping rules, and relying on the wrong one is how an
 * injection gets written. Taking it from `textContent` means there is no
 * JavaScript context for it to escape from, and it keeps these bytes constant
 * so the CSP hash can be computed once.
 *
 * The button is an addition, not a requirement: `user-select: all` on the code
 * block already makes one click select the whole thing, which is what happens
 * when the clipboard API is unavailable -- on an insecure origin, or where the
 * permission is refused.
 */
/**
 * Confirms before discarding a client's permissions.
 *
 * Restoring defaults is mostly a loosening -- it removes grants -- but not
 * always: a tool someone deliberately Blocked that defaults to Allow becomes
 * callable again. That makes it a safety-relevant click, and it is next to the
 * Save button people press routinely.
 *
 * Degrades honestly. With no script the form still submits, so the control
 * works everywhere; the prompt is a courtesy, not the protection. The real
 * protection is that the settings it clears are visible on the page and can be
 * set again.
 */
const RESET_CONFIRM_SCRIPT = `
(function () {
  var buttons = document.querySelectorAll('.reset-policy');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) {
      var count = this.getAttribute('data-count') || 'all';
      var message = 'Clear ' + count + ' permission setting(s) for this client and return it to Courier defaults?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  }
})();
`.trim();

const COPY_SCRIPT = `
(function () {
  var button = document.getElementById('copy');
  var label = document.getElementById('copy-label');
  var block = document.getElementById('code');
  if (!button || !label || !block) return;

  function select() {
    var range = document.createRange();
    range.selectNodeContents(block);
    var selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  button.addEventListener('click', function () {
    var code = block.textContent || '';
    function confirmed(text) {
      label.textContent = text;
      setTimeout(function () { label.textContent = 'Copy code'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () {
        confirmed('Copied');
      }, function () {
        // Say what happened rather than claiming success: a label reading
        // "Copied" over an empty clipboard sends someone back to the terminal
        // to paste nothing.
        select();
        confirmed('Press Ctrl-C to copy');
      });
      return;
    }
    select();
    confirmed('Press Ctrl-C to copy');
  });
})();
`.trim();

/**
 * Shown when the out-of-band redirect arrives without a code.
 *
 * Almost always a declined consent screen, where the provider redirects with
 * `error` instead. Rendered as its own page rather than folded into the code
 * page, so nothing that looks like a code is ever shown when there is none.
 */
export function renderOobErrorPage(error: string, description?: string): string {
    return documentShell(
        'Courier',
        `<main class="center-card oob">
          ${brandMark()}
          <h1>Authorization was not completed</h1>
          <p>${escapeHtml(description || 'The sign-in did not finish, so no code was issued.')}</p>
          <div class="notice">
            <strong>Reported as:</strong> ${escapeHtml(error)}<br />
            Return to the terminal and run <code>courier auth login</code> again.
          </div>
        </main>`
    );
}

export function renderNoVaultPage(): string {
    return documentShell(
        'Courier',
        `<main class="center-card">
          ${brandMark()}
          <h1>Encrypted storage unavailable</h1>
          <p>Courier cannot save account credentials until its encrypted vault is configured.</p>
          <div class="notice">Set <strong>COURIER_VAULT_KEY</strong> and restart the service.</div>
        </main>`
    );
}

export interface UiClient {
    clientId: string;
    clientName?: string;
    ownerId?: string;
    promotedAt?: number;
    lastSeenAt?: number;
    lastSeenFrom?: string;
    /** Only the tools whose tier was deliberately set for this client. */
    policy?: Record<string, Tier>;
}

/**
 * Every tool, grouped for display, with the ungrouped account tools last.
 *
 * Built from the same group definitions the tool registry uses, so a tool added
 * to a group appears here without anyone remembering to update a second list.
 */
const POLICY_SECTIONS: { label: string; description: string; tools: string[] }[] = [
    ...TOOL_GROUPS.map((group) => ({
        label: group.label,
        description: group.description,
        tools: group.tools,
    })),
    {
        label: 'Accounts',
        description: 'How a client discovers and targets your accounts.',
        tools: [...ALWAYS_AVAILABLE_TOOLS],
    },
];

const ALL_TOOL_NAMES: string[] = POLICY_SECTIONS.flatMap((section) => section.tools);

const TIER_LABELS: Record<Tier, string> = {
    allow: 'Allow',
    // Named for what it does HERE, which is refuse.
    //
    // "Ask first" means asking through MCP elicitation, and elicitation needs a
    // session: this server builds a fresh one per request, so a client's reply
    // to a question would arrive at an instance that never asked it. The tier
    // is implemented and refuses rather than allows when nobody can be asked,
    // which is safe -- but offering it as "Ask first" promised a prompt that
    // cannot be delivered, and a setting that silently means something else is
    // worse than no setting.
    confirm: 'Ask first (unavailable here — acts as Block)',
    deny: 'Block',
};

/**
 * One tool's permission control.
 *
 * A row in the client's single form, not a form of its own. It used to be one
 * form per tool with its own Set button, which meant changing five permissions
 * was five page loads -- and the reason for it (not clobbering a change made
 * elsewhere) is better served by only writing the rows that actually changed.
 *
 * The value the page was rendered with travels alongside the control, so the
 * server can tell an edited row from an untouched one. A row nobody touched is
 * never written, so two people editing different tools on the same client do
 * not overwrite each other; two people editing the SAME tool still conflict,
 * which is a real conflict rather than an artefact of the form.
 */
function renderToolPolicy(toolName: string, overrides: Record<string, Tier>): string {
    const current = overrides[toolName];
    const effective = tierFor(toolName, overrides);
    const fallback = defaultTierFor(toolName);
    const selected = current ?? '';

    const options = [
        { value: '', label: `Default (${TIER_LABELS[fallback]})` },
        ...TIERS.map((tier) => ({ value: tier as string, label: TIER_LABELS[tier] })),
    ];

    return `<div class="tool-policy">
        <div class="tool-policy-copy">
          <code>${escapeHtml(toolName)}</code>
          <span>It ${escapeHtml(consequenceOfForDisplay(toolName))}.</span>
        </div>
        <div class="tool-policy-controls">
          <input type="hidden" name="was.${escapeHtml(toolName)}" value="${escapeHtml(selected)}" />
          <select name="tier.${escapeHtml(toolName)}" aria-label="Permission for ${escapeHtml(toolName)}">
            ${options
                .map(
                    (option) =>
                        `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
                )
                .join('')}
          </select>
          <span class="badge tier-${effective}">${escapeHtml(TIER_LABELS[effective])}</span>
        </div>
      </div>`;
}

/**
 * What a tool does, phrased for someone deciding whether to permit it.
 *
 * Reads get a plain description rather than the change-oriented wording the
 * refusal message uses, which reads oddly next to a tool that only looks.
 */
function consequenceOfForDisplay(toolName: string): string {
    return ALL_READ_TOOLS.has(toolName) ? 'only reads' : consequenceOf(toolName);
}

function renderPolicyGroups(client: UiClient, overrides: Record<string, Tier>): string {
    const changed = Object.keys(overrides).length;
    const sections = POLICY_SECTIONS.map(
        (section) => `<section class="policy-section">
          <h3>${escapeHtml(section.label)}</h3>
          <p class="card-intro">${escapeHtml(section.description)}</p>
          ${section.tools.map((tool) => renderToolPolicy(tool, overrides)).join('')}
        </section>`
    ).join('');

    return `<form method="post" action="/ui/clients/policy">
        <input type="hidden" name="clientId" value="${escapeHtml(client.clientId)}" />
        ${sections}
        <div class="actions">
          <button class="button primary" type="submit" name="intent" value="save">${checkIcon} Save permissions</button>
          ${
              changed > 0
                  ? `<button class="button secondary reset-policy" type="submit" name="intent" value="reset" data-count="${changed}">Restore defaults</button>`
                  : ''
          }
          <span class="hint">${
              changed > 0
                  ? `Only the ones you changed are written. Restoring clears all ${changed} of your settings for this client.`
                  : 'Only the ones you changed are written.'
          }</span>
        </div>
      </form>`;
}

/** "3 minutes ago" style relative time; absolute dates are noise at this scale. */
function relativeTime(timestamp: number | undefined, now: number = Date.now()): string {
    if (timestamp === undefined) return 'unknown';
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    // Each pair is the divisor to leave the current unit and the unit it yields,
    // so the name always describes the value *after* the division.
    const units: Array<[number, string]> = [
        [60, 'minute'],
        [60, 'hour'],
        [24, 'day'],
        [7, 'week'],
        [4.35, 'month'],
        [12, 'year'],
    ];

    let value = seconds;
    let unit = 'second';
    for (const [size, nextUnit] of units) {
        if (value < size) break;
        value = Math.floor(value / size);
        unit = nextUnit;
    }
    if (unit === 'second' && value < 45) return 'just now';
    return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

export function renderUiPage(
    user: UiUser,
    accounts: UiAccount[],
    defaultAccount: string | null,
    selectedAccountName: string | null = null,
    clients: UiClient[] = [],
    unattributedClients: UiClient[] = []
): string {
    const selectedAccount =
        accounts.find((account) => account.name === selectedAccountName) ?? null;
    const accountRows = accounts
        .map((account) => {
            const name = escapeHtml(account.displayName?.trim() || account.name);
            const email = escapeHtml(account.name);
            const isDefault = account.name === defaultAccount;
            const isSelected = account.name === selectedAccount?.name;
            const caldavEnabled = Boolean(account.caldav?.password);
            const editUrl = `/ui?account=${encodeURIComponent(account.name)}#account-form`;
            return `<a class="account${isSelected ? ' selected' : ''}" href="${editUrl}" aria-label="Edit ${email}">
              <div class="account-main">
                <span class="account-name">${name}</span>
                ${name !== email ? `<span class="account-email">${email}</span>` : ''}
              </div>
              <div class="account-actions">
                <div class="badges">
                  ${isDefault ? '<span class="badge default">Default</span>' : ''}
                  <span class="badge">${caldavEnabled ? 'Mail + calendar' : 'Mail only'}</span>
                </div>
                <span class="edit-account">${isSelected ? 'Editing' : 'Edit account'}</span>
              </div>
            </a>`;
        })
        .join('');

    const accountsContent =
        accountRows ||
        `<div class="empty">
          <span class="empty-icon">${envelopeIcon}</span>
          <strong>No accounts connected</strong>
          <p>Add an account to make mail, contacts, calendars, and tasks available to your MCP clients.</p>
        </div>`;

    /**
     * One client, with its permissions.
     *
     * Permissions are rendered per client rather than per tool because the
     * question a person actually has is "what can ChatGPT do", not "who can
     * send mail". Collapsed by default: there are forty-odd tools and the
     * common case is wanting to see which clients exist, not to audit one.
     */
    const renderClientRow = (client: UiClient, unattributed: boolean) => {
        const name = escapeHtml(client.clientName?.trim() || 'Unnamed client');
        const overrides = client.policy ?? {};
        const changed = Object.keys(overrides).length;
        const restricted = ALL_TOOL_NAMES.filter(
            (tool) => tierFor(tool, overrides) !== 'allow'
        ).length;

        return `<div class="client" id="client-${escapeHtml(client.clientId)}">
            <div class="client-main">
              <span class="client-name">${name}</span>
              <span class="client-meta">Authorized ${escapeHtml(relativeTime(client.promotedAt))} · Last used ${escapeHtml(relativeTime(client.lastSeenAt))}${
                  // Which machine, not just which client: several of these are
                  // named for software that runs on more than one.
                  client.lastSeenFrom ? ` · from ${escapeHtml(client.lastSeenFrom)}` : ''
              }</span>
              ${unattributed ? '<span class="client-meta">Authorized before Courier recorded which user connected it.</span>' : ''}
              <span class="client-meta">${restricted} of ${ALL_TOOL_NAMES.length} tools restricted${changed ? ` · ${changed} set by you` : ' · all at their defaults'}</span>
              <span class="client-meta client-id">${escapeHtml(client.clientId)}</span>
            </div>
            <form method="post" action="/ui/clients/revoke">
              <input type="hidden" name="clientId" value="${escapeHtml(client.clientId)}" />
              <button class="button danger" type="submit">Revoke</button>
            </form>
          </div>
          <details class="client-policy">
            <summary><span>Permissions for ${name}</span></summary>
            <p class="card-intro">
              Every tool is offered to every client; this decides what happens when one is
              called. Changes take effect immediately and need no reconnection.
              &ldquo;Ask first&rdquo; needs a client that can show a prompt over a persistent
              session, which this server does not keep &mdash; so it currently refuses the
              call, exactly like Block.
            </p>
            ${renderPolicyGroups(client, overrides)}
          </details>`;
    };

    const clientRows = clients.map((client) => renderClientRow(client, false)).join('');
    const unattributedRows = unattributedClients
        .map((client) => renderClientRow(client, true))
        .join('');
    const clientsContent =
        clientRows || unattributedRows
            ? `${clientRows}${
                  unattributedRows
                      ? `<p class="card-intro unattributed-note">Authorized before ownership was recorded</p>${unattributedRows}`
                      : ''
              }`
            : `<div class="empty">
                <strong>No clients authorized yet</strong>
                <p>MCP clients appear here once you complete a sign-in from them.</p>
              </div>`;

    const identity = escapeHtml(user.email?.trim() || 'Authenticated user');
    const editing = Boolean(selectedAccount);
    const selectedEmail = escapeHtml(selectedAccount?.name ?? '');
    const selectedDisplayName = escapeHtml(selectedAccount?.displayName ?? '');
    const selectedCaldavUsername = escapeHtml(selectedAccount?.caldav?.username ?? '');
    const selectedIsDefault = selectedAccount?.name === defaultAccount;
    const hasStoredToken = editing;
    const hasStoredCaldavPassword = Boolean(selectedAccount?.caldav?.password);

    return documentShell(
        'Courier Setup',
        `<main class="shell">
          <header class="topbar">
            <div class="brand">
              ${brandMark()}
              <div class="brand-copy">
                <p class="brand-name">Courier</p>
                <p class="brand-tagline">Private MCP account gateway</p>
              </div>
            </div>
            <div class="identity" title="Authenticated with OIDC">
              <span class="identity-dot">${checkIcon}</span>
              <span class="identity-copy">
                <span class="identity-label">Secure session</span>
                <span class="identity-value">${identity}</span>
              </span>
            </div>
          </header>

          <section class="hero">
            <p class="eyebrow">Account setup</p>
            <h1>Your mail, delivered securely.</h1>
            <p>Connect accounts once. Courier encrypts their credentials at rest and keeps each authenticated MCP user isolated.</p>
          </section>

          <div class="content-grid">
            <section class="card" aria-labelledby="accounts-heading">
              <div class="card-header">
                <div>
                  <h2 id="accounts-heading">Connected accounts</h2>
                  <p class="card-intro">Accounts available to your signed-in identity.</p>
                </div>
                <span class="count" aria-label="${accounts.length} connected accounts">${accounts.length}</span>
              </div>
              <div class="account-list">${accountsContent}</div>
            </section>

            <section class="card" id="account-form" aria-labelledby="account-form-heading">
              <div class="card-header">
                <div>
                  <h2 id="account-form-heading">${editing ? 'Update account' : 'Add an account'}</h2>
                  <p class="card-intro">${editing
                      ? 'Leave either credential blank to keep its current value.'
                      : 'Connect another account to Courier.'}</p>
                </div>
              </div>

              <form method="post" action="/ui/account">
                <div class="form-grid">
                  <div class="field">
                    <label for="email">Account email</label>
                    <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${selectedEmail}" ${editing ? 'readonly' : ''} required />
                  </div>

                  <div class="field">
                    <label for="displayName">Display name</label>
                    <input id="displayName" name="displayName" type="text" autocomplete="off" placeholder="Personal" value="${selectedDisplayName}" />
                  </div>

                  <div class="field full">
                    <div class="field-label">
                      <label for="token">JMAP API token</label>
                      ${hasStoredToken ? '<span class="credential-status">Stored securely</span>' : ''}
                    </div>
                    <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="${hasStoredToken ? '•••••••••••• (stored)' : ''}" />
                    <span class="hint">${hasStoredToken
                        ? 'No need to re-enter it. Leave blank to keep the stored token, or enter a replacement.'
                        : 'Required for a new account.'}</span>
                  </div>

                  <div class="field">
                    <div class="field-label">
                      <label for="caldavPassword">CalDAV app password</label>
                      ${hasStoredCaldavPassword ? '<span class="credential-status">Stored securely</span>' : ''}
                    </div>
                    <input id="caldavPassword" name="caldavPassword" type="password" autocomplete="off" spellcheck="false" placeholder="${hasStoredCaldavPassword ? '•••••••••••• (stored)' : ''}" />
                    <span class="hint">${hasStoredCaldavPassword
                        ? 'Leave blank to keep the stored password, or enter a replacement.'
                        : 'Optional. Enables calendars and tasks.'}</span>
                  </div>

                  <div class="field">
                    <label for="caldavUsername">CalDAV username</label>
                    <input id="caldavUsername" name="caldavUsername" type="text" autocomplete="username" placeholder="Defaults to email" value="${selectedCaldavUsername}" />
                  </div>

                  <div class="checkbox-row">
                    <input id="setDefault" name="setDefault" type="checkbox" ${selectedIsDefault ? 'checked' : ''} />
                    <div class="checkbox-copy">
                      <label for="setDefault">Use as the default account</label>
                      <span>New MCP requests will use this account unless a client selects another one.</span>
                    </div>
                  </div>
                </div>

                <div class="actions">
                  <button class="button primary" type="submit">
                    ${checkIcon}
                    ${editing ? 'Update account' : 'Add account'}
                  </button>
                  ${editing ? '<a class="button secondary" href="/ui">Cancel</a>' : ''}
                  <span class="hint">Secrets are encrypted before they are written to disk.</span>
                </div>
              </form>
            </section>
          </div>

          <section class="card clients-card" aria-labelledby="clients-heading">
            <div class="card-header">
              <div>
                <h2 id="clients-heading">Authorized clients</h2>
                <p class="card-intro">Apps you have signed into from an MCP client. Revoking one cuts off its access immediately and forces it to sign in again.</p>
              </div>
              <span class="count" aria-label="${clients.length + unattributedClients.length} authorized clients">${clients.length + unattributedClients.length}</span>
            </div>
            <div class="client-list">${clientsContent}</div>
          </section>

          <div class="actions">
            <p class="footer-note">Courier only exposes accounts to the authenticated identity that configured them.</p>
            <form method="post" action="/auth/logout">
              <button class="button secondary" type="submit">Sign out</button>
            </form>
          </div>
        </main>`,
        RESET_CONFIRM_SCRIPT
    );
}
