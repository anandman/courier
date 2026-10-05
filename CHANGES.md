# Unreleased Changes (vs. GitHub `main` @ `2a0a636`)

## Breaking: renamed again, to Courier

**Email Courier** is now simply **Courier**. The previous name undersold it:
the DAV path carries calendar, contacts and tasks, so naming it after email
described one part of the whole. A CLI is also planned, which rules out any
`-mcp` suffix for the same reason.

| Was | Now |
|---|---|
| package `email-courier` | `courier` |
| command `email-courier-mcp` | `courier` |
| MCP server name `email-courier` | `courier` |

**The env vars are unchanged** — they were already `COURIER_*` from the previous
rename, which is why that prefix was chosen.

Config and state directories are **not** moved by this change; see the
deployment notes for the path migration.

## Breaking: renamed to Email Courier

The project was **Fastmail Courier**; it is now **Email Courier**. Fastmail asked
that their trademark not appear in a third-party client's name, and the server was
in any case never Fastmail-specific — it speaks JMAP and CalDAV, and works with any
JMAP provider.

Nothing about the protocol behaviour changed. What you must update:

| Was | Now |
|---|---|
| `FASTMAIL_API_TOKEN` | `COURIER_API_TOKEN` |
| `FASTMAIL_EMAIL` | `COURIER_EMAIL` |
| `FASTMAIL_CALDAV_USERNAME` | `COURIER_CALDAV_USERNAME` |
| `FASTMAIL_CALDAV_PASSWORD` | `COURIER_CALDAV_PASSWORD` |
| `FASTMAIL_VAULT_FILE` / `_KEY` / `_BACKEND` | `COURIER_VAULT_FILE` / `_KEY` / `_BACKEND` |
| `FASTMAIL_TEST_ENV_FILE` | `COURIER_TEST_ENV_FILE` |
| `~/.config/fastmail-courier/` | `~/.config/email-courier/` |
| `~/.local/state/fastmail-courier/` | `~/.local/state/email-courier/` |
| package `fastmail-courier`, bin `fastmail-mcp` | `email-courier`, bin `email-courier-mcp` |
| exported `FastmailCalDAVClient` | `CalDAVClient` |

**No backward-compatible aliases are provided.** The old variable names are not
read at all, so a stale config fails loudly rather than silently falling back.

Clients must be re-added: the name advertised over MCP changed from
`fastmail-courier` to `email-courier`.

## Summary

Three major areas of work since the last commit:

1. **Remote HTTP hosting** — Streamable HTTP transport, OIDC/proxy authentication, encrypted credential vault, per-user request context, and a browser-based setup UI.
2. **Token-efficiency improvements** — Tool descriptions rewritten to guide LLMs toward cheaper call patterns (search then read, use filters, lower limits).
3. **Recurring event fix** — `list_events` now uses server-side recurrence expansion so recurring events return correct occurrence dates.

---

## New Files

| File | Purpose |
|------|---------|
| `src/auth/oidc.ts` | Full OIDC/OAuth2 auth: discovery, JWT verification, token introspection fallback, user allowlist |
| `src/auth/proxy.ts` | Auth-proxy middleware (Cloudflare Access, oauth2-proxy, etc.) — extracts identity from HTTP headers |
| `src/auth/session.ts` | HMAC-SHA256 session tokens for the browser UI (sign/verify with expiry) |
| `src/types/express.d.ts` | Extends Express `Request` with optional `auth: AuthInfo` |
| `src/vault/crypto.ts` | AES-256-GCM encrypt/decrypt for JSON payloads; vault key parsing (hex or base64) |
| `src/vault/types.ts` | `VaultStore` interface (get/set/list user configs) |
| `src/vault/index.ts` | Factory that returns the configured vault backend |
| `src/vault/file-vault.ts` | File-based encrypted vault (`~/.config/email-courier/vault.json`), atomic writes, chmod 0600 |
| `src/request-context.ts` | `AsyncLocalStorage`-based request context (account manager, auth info, user ID per request) |
| `src/user-accounts.ts` | Factory to create an `AccountManager` for a specific user from vault-stored config |

## Modified Files

### `src/index.ts` (+500 lines)

The biggest change. Previously just a stdio MCP server; now supports two transports:

- **stdio** (default, unchanged behavior)
- **Streamable HTTP** (`MCP_TRANSPORT=http`) via `@modelcontextprotocol/sdk`'s Express integration

When running in HTTP mode, the server adds:

- **Auth middleware** — OIDC bearer-token validation or proxy-header extraction (configurable via `MCP_AUTH_MODE`)
- **Per-request context** — `runWithRequestContext()` wraps each MCP call so tool handlers resolve the correct user's account manager
- **Credential vault UI** — `/ui` serves a small HTML page where authenticated users can add/update their Fastmail API token and CalDAV password, stored encrypted in the vault
- **OAuth metadata** — `/.well-known/oauth-protected-resource` and related endpoints for OIDC discovery
- **Health endpoint** — `GET /health`
- **Host-header validation** — optional `MCP_HTTP_ALLOWED_HOSTS`
- **Stateful sessions** — session tracking with in-memory transport map (configurable via `MCP_HTTP_STATEFUL`)

Environment variables added: `MCP_TRANSPORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`, `MCP_HTTP_ALLOWED_HOSTS`, `MCP_HTTP_STATEFUL`, `MCP_PUBLIC_URL`, `MCP_AUTH_MODE`, `MCP_ALLOWED_USERS`, `MCP_USER_ID_CLAIM`, `MCP_OIDC_*`, `MCP_UI_SESSION_*`, `MCP_AUTH_PROXY_*`, `FASTMAIL_VAULT_*`.

### `src/account-manager.ts`

- Added `AccountManagerOptions` interface with `initialConfig`, `allowEnv`, `allowConfigFile`, `configFilePath`, and `onChange` callback
- Constructor now accepts options (breaking: previously no-arg)
- `loadConfiguration()` refactored to respect options (can skip env vars and config file when running in multi-user vault mode)
- `applyConfig()` extracted as a reusable method
- Added `getFullConfig()` to export the current configuration for persistence
- Imports `getRequestContext` (used downstream)

### `src/caldav/client.ts`

- **`getEvents()`** — Uses `timeRange` + `expand: true` on `fetchCalendarObjects` for server-side recurrence expansion (RFC 4791). Defaults to now → +90 days when no date range given. Default limit raised from 100 to 1000. Client-side `matchesEventFilter()` no longer called (server already filters).
- **`parseVEVENT()`** — Now parses `RECURRENCE-ID` field; sets `isRecurrence` and `recurrenceId` on returned events.

### `src/caldav/types.ts`

- Added `isRecurrence?: boolean` and `recurrenceId?: string` to `CalendarEvent`

### `src/tools/index.ts`

- All 22 tool descriptions rewritten to be shorter and guide LLMs toward token-efficient usage patterns (e.g., "use search_emails first", "token-expensive", "lightweight", "use a tight date range + limit")

### `src/tools/calendar.ts`

- Schema descriptions updated with token-efficiency hints (e.g., "keep results small", "keep concise", "use list_tasks first")

### `src/tools/search.ts`

- Schema descriptions updated ("use to narrow results and save tokens", "Lower = fewer tokens")

### `src/tools/read.ts`

- `getEmailSchema` description updated ("use after search_emails to minimize tokens")

### `src/tools/send.ts`

- `sendEmailSchema.body` description: "Keep concise if token usage matters"
- `forwardEmailSchema.emailId` description: "use IDs from search_emails"

### `src/tools/organize.ts`

- All `emailIds` descriptions updated: "use IDs from search_emails to avoid extra reads"

### `src/tools/accounts.ts`

- `switchAccountSchema.account` description enhanced

### `package.json`

- Added dependencies: `express` (^4.21.2), `jose` (^5.9.3)
- Added devDependency: `@types/express` (^4.17.21)

### `package-lock.json`

- Lockfile updated for new dependencies (express v4, jose v5, and their transitive deps)

### Documentation

- **`README.md`** — Added "Remote Hosting (Optional)" section with quick-start examples for HTTP transport and OIDC
- **`docs/configuration.md`** — Added all new env vars to the reference table; added "Remote Hosting", "Authentication", and "Encrypted Vault" sections
- **`docs/getting-started.md`** — Added "Remote Hosting (Optional)" and "Multi-User Remote Hosting" sections
- **`docs/tools.md`** — Added "Token-Smart Usage" guidance section; updated `search_emails` and `get_email` descriptions

---

## Dependencies Added

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.21.2 | HTTP server for Streamable HTTP transport |
| `jose` | ^5.9.3 | JWT verification and OIDC token handling |
| `@types/express` | ^4.17.21 | TypeScript types (dev) |

## Not Changed

- `rrule` dependency was considered but not needed — server-side `expand: true` handles all recurrence expansion
- No test files were added or modified
- No changes to VTODO (task) handling
- No changes to JMAP/email internals
