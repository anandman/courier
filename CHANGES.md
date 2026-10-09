# Unreleased Changes (vs. GitHub `main` @ `2a0a636`)

## New: `courier` is a command-line client as well as a server

`courier auth login` authorizes a machine against a running Courier over OAuth
2.1 with PKCE, registering itself via RFC 7591 dynamic client registration.
Every tool is then a subcommand, with flags derived from the server's own
schemas:

```bash
courier auth login --server https://your-courier.example/mcp
courier search-emails --query invoice --limit 20 --all
courier draft-reply --email-id StnZCocGyMEV --body "Sounds good." --yes
```

The point is that a consumer no longer needs a copy of the JMAP API token or
the DAV app password. It holds a refresh token for Courier; the mail
credentials stay on the server, in one copy each, and can be rotated in one
place.

**The exit code is the contract.** `courier exit-codes` prints it as JSON.
Exit 0 means the server answered the exact question asked, completely; every
other code writes nothing data-shaped to stdout — not a partial page set, not
an empty array. A consumer piping stdout into a cache cannot ingest a failure
even if it ignores the exit code, because there is nothing there to ingest. The
corollary is what makes it useful: an empty result *with* exit 0 is
trustworthy.

`--all` walks a paged result set and is all-or-nothing: if any page fails, or
the page ceiling is reached first, the pages already collected are discarded
and the command exits `incomplete` rather than printing a partial set that
looks whole.

Anything that is not a read requires `--yes`, or an interactive confirmation
when there is a terminal. Without either, the command exits `forbidden` and
does nothing — so an unattended script cannot send mail by omission. The CLI
implements no *deny*: refusing a tool outright is a per-client policy decision
and belongs to the server.

`auth login` opens a browser and catches the redirect locally, which is what a
CLI run on its user's own machine should do. When the browser is somewhere else
— SSH, mosh, a container — `auth login --remote` sends it to a new Courier page
that **displays the authorization code** to paste back, the flow familiar from
`gcloud` and `gh`. That page is a generic out-of-band redirect target at
`GET /auth/oob`, available to any client that registers the URI; it sets
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and showing the
code is safe because Courier already mandates PKCE — the code is single-use,
lives five minutes, and is exchangeable only by the holder of the verifier,
which never leaves the CLI's machine.

Nothing tries to detect which situation you are in: `SSH_CONNECTION` is unset
under mosh and most remote shells, and `DISPLAY` says only that a screen exists
on the machine. A wrong guess fails in the worst available way — the
authorization succeeds, the redirect goes to a loopback port on another host,
and the only symptom is a command that times out. So the default is optimistic
*and* recovers: it accepts a pasted redirect URL as well, so landing on an
unreachable `127.0.0.1` page costs a copy rather than the login.

Without a terminal to paste at, the flow splits into `auth login` (prints a
URL, exits 0) and `auth login --code "<code>"`, with the PKCE verifier and
state persisted between them. A login must complete within 10 minutes — the
window Courier itself allows between `/authorize` and the identity provider's
callback.

`courier mcp [--stdio|--http]` runs the server. `node dist/index.js` and the
`courier-mcp` executable continue to work unchanged.

See [docs/cli.md](docs/cli.md).

## New: permissions are per client, per tool

Courier now decides what each connected client may do, tool by tool, enforced
at `tools/call`. Allow, ask first, or block — set in the settings UI against
each authorized client, stored in the OAuth client registry and keyed on
`client_id`.

**Every tool stays advertised to every client.** Permission is not expressed by
hiding things: clients cache the tool list, and several only notice a change
when the server is removed and re-added by hand, so a permission change must
not alter what is offered.

Defaults divide on **reversibility**, because a confirmation cannot actually be
delivered over the stateless HTTP transport — a fresh `Server` is built per
request, so the capabilities declared at `initialize` belong to another instance
and the client's reply to a server-initiated request would arrive at a third.
With no workable middle tier, the question becomes which mistakes a person can
undo. Reads and reversible changes run; `send_email`, `forward_email` and the
deletions that really delete are blocked until granted. `delete_emails` is
allowed, because it moves mail to Trash.

"Ask first" remains selectable per client and is fully implemented, including
the rule that a client which cannot ask anyone is refused rather than allowed —
treating "nobody could be asked" as consent would turn it into a blanket allow
for exactly the unattended clients it exists to constrain. It becomes reachable
if the transport ever gains a session.

## Removed: server-wide tool group toggles

The old Advanced section turned whole feature areas off for every client at
once. The granularity was wrong in both directions: stopping one client from
sending mail meant losing search and reading with it, and there was no way to
let a CLI draft while withholding the same tool from a chat assistant. Per-client
permissions replace it entirely. The grouping survives only as a way to arrange
forty-odd tools on the settings page.

Stored `disabledToolGroups` values are ignored. If you had turned a group off,
those tools are available again — and restricting them is now a per-client
decision.

## Changed: `threaded` is now `threadingHeadersWritten`

A draft tool's result reported `threaded: true`, which read as a prediction —
"this will appear as a reply". It is a fact about the stored draft, and the two
diverge exactly where it matters.

A consumer measured three Courier-written replies arriving as new conversations
while four hand-written ones threaded correctly, and reported that Courier was
stripping the headers. It was not: the stored drafts carry In-Reply-To and
References all the way down to the RFC 5322 bytes, verified by downloading the
raw message. The headers were lost when the drafts were opened in a mail client
and sent — a composer that rebuilds a draft on send drops headers it does not
manage.

So the field was telling the truth and the reader drew the wrong conclusion from
it, which is the field's fault. It now names what it can guarantee, and the
message says that threading also depends on how the draft is sent.

Worth knowing downstream: anything answering "has this been replied to?" by
threadId or In-Reply-To gets a false negative when a draft is sent by a client
that rebuilds it. Matching on normalised subject as well is a reasonable
mitigation.

## Fixed: a bad command line reported as an authentication failure

Authentication was checked before the command line was parsed, so with no
stored credential *every* mistake came back as `no-auth` — a mistyped flag sent
an operator to inspect a credential that was never the problem, and the
documented `usage` code was unreachable. Found by a consumer session testing
the contract.

The CLI now validates arguments against the schemas it ships with before
touching the credential store, and `courier help <tool>` needs no credential at
all. An unrecognised tool *name* still defers to the server — this build may be
talking to a newer Courier carrying tools it has never heard of — but the
message says the name is unknown here too, so the operator is not sent to the
wrong place.

## Fixed: `switch_account` reported failure as data

Switching to an account that does not exist returned `success: false` with a
message, which left the MCP envelope reporting a *successful* call. A client
that checks the envelope — which is all an `isError` check or an exit code can
see — took that as a completed switch and carried on against whichever account
was already current, silently operating on the wrong mailbox.

It now throws, which is what every other tool already did for the same
condition: `createAccountScopedTool` refuses an unknown `account` parameter
that way on all of them. This one was the exception.

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
