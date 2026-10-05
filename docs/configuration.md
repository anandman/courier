# Configuration

Detailed configuration options for Courier.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COURIER_API_TOKEN` | Yes | JMAP API token (starts with `fmu1-`) |
| `COURIER_EMAIL` | Yes* | Your Fastmail email address |
| `COURIER_CALDAV_PASSWORD` | No | App password for calendar/tasks |
| `COURIER_CALDAV_USERNAME` | No | CalDAV username (defaults to the account email) |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` for Streamable HTTP hosting |
| `MCP_HTTP_HOST` | No | Host to bind for HTTP transport (default `127.0.0.1`) |
| `MCP_HTTP_PORT` | No | Port for HTTP transport (default `3333`) |
| `MCP_HTTP_PATH` | No | Path for MCP endpoint (default `/mcp`) |
| `MCP_HTTP_ALLOWED_HOSTS` | No | Comma-separated hostnames allowed in Host header (optional) |
| `MCP_PUBLIC_URL` | No | Public base URL used for OAuth metadata and UI redirects |
| `MCP_AUTH_MODE` | No | `oidc`, `proxy`, or `none` (auto-detected if unset) |
| `MCP_ALLOWED_USERS` | **Yes** (oidc/proxy) | Comma-separated allowlist of emails or user IDs. The server refuses to start without it |
| `MCP_ALLOW_ANY_AUTHENTICATED_USER` | No | Set `true` to run with no allowlist, accepting every identity the provider authenticates |
| `MCP_USER_ID_CLAIM` | No | Claim to identify users (`email` default, `sub` optional) |
| `MCP_OIDC_ISSUER_URL` | No | Identity provider issuer URL (required for OIDC auth) |
| `MCP_OIDC_CLIENT_ID` | No | Client ID Courier uses at the identity provider |
| `MCP_OIDC_CLIENT_SECRET` | No | Client secret Courier uses at the identity provider |
| `MCP_OIDC_SCOPES` | No | Scopes requested at login (default `openid email profile`) |
| `MCP_OIDC_REQUIRED_SCOPES` | No | Scopes required for MCP requests (optional) |
| `MCP_OIDC_REDIRECT_URI` | No | Override UI login redirect (defaults to `${MCP_PUBLIC_URL}/auth/callback`) |
| `MCP_OIDC_MCP_REDIRECT_URI` | No | Override MCP login redirect (defaults to `${MCP_PUBLIC_URL}/auth/mcp/callback`) |
| `MCP_TOKEN_SECRET` | No | Secret for signing MCP access/refresh tokens, min 32 chars (defaults to `MCP_UI_SESSION_SECRET`) |
| `MCP_ACCESS_TOKEN_TTL` | No | MCP access token lifetime in seconds (default 3600) |
| `MCP_REFRESH_TOKEN_TTL` | No | MCP refresh token lifetime in seconds (default 2592000) |
| `MCP_OAUTH_CLIENTS_FILE` | No | Registered MCP client store (defaults beside the vault file) |
| `MCP_SERVICE_DOCUMENTATION_URL` | No | Advertised in metadata as `resource_documentation` (omitted if unset) |
| `MCP_ACCESS_LOG` | No | Set `1` to log method, path, status, duration and source IP, plus one line per MCP handshake |
| `MCP_TOOL_LOG` | No | Set `1` to log one line per tool call: name, argument *keys*, duration, outcome |
| `MCP_UI_SESSION_SECRET` | No | HMAC secret for UI sessions (defaults to `COURIER_VAULT_KEY`) |
| `MCP_UI_SESSION_TTL` | No | UI session TTL in seconds (default 604800) |
| `MCP_AUTH_PROXY_EMAIL_HEADER` | No | Header name for proxy-auth email (default `x-auth-email`) |
| `MCP_AUTH_PROXY_SUB_HEADER` | No | Header name for proxy-auth subject (default `x-auth-user`) |
| `COURIER_VAULT_BACKEND` | No | Vault backend (`file` default) |
| `COURIER_VAULT_FILE` | No | Vault file path (default `~/.config/email-courier/vault.json`) |
| `COURIER_VAULT_KEY` | No | 32-byte vault key (base64 or hex) for encrypted storage |

*Required if using environment variables; inferred from token discovery if using config file.

Streamable HTTP requests are handled statelessly. Each request receives an
isolated MCP server and transport so multiple clients can use the endpoint
simultaneously.

The setup UI always sends `prompt=login` when starting OIDC authorization.
Signing out clears Courier's local UI session and returns to a non-cacheable
login page. This makes identity selection interactive without relying on a
provider-specific logout endpoint.

## Available Tools (per user)

Courier exposes 36 tools in four feature groups — **Email** (15), **Contacts** (6),
**Calendar** (6) and **Tasks** (6) — plus three account tools that are
always available, since they are how clients discover and target accounts.

Each signed-in identity chooses which groups to expose, under **Advanced —
available tools** in the setup UI. This is a per-user preference rather than
server configuration: one person may never use tasks while another
relies on them, and both are served by the same Courier.

A hidden group is omitted from `tools/list` *and* refused if called, so a client
holding a cached tool list cannot keep using it. Turning off groups you do not
need also leaves more room in the model's context for the ones you do.

The preference is stored with the user's accounts as `disabledToolGroups`. An
absent value means everything is enabled, so existing configs need no migration
and groups added in future versions are on by default.

Clients cache the tool list, so changing this does not take effect immediately.
Courier emits `notifications/tools/list_changed` on the next request a stale
client makes, which prompts a well-behaved client to refetch. That notification
rides an in-flight request — the HTTP transport is stateless and has no standing
connection to push on — so it arrives one turn late, and a client that ignores
it simply keeps the stale list until it reconnects. The call-time refusal is
what guarantees a hidden tool cannot be used regardless.

## Authorized Clients

Every MCP client that completes a sign-in is recorded against the identity that
authorized it and listed under **Authorized clients** in the setup UI, with when
it was authorized and when it was last used.

**Revoke** removes it. Its refresh token stops working immediately, and its
existing access token stops working on its next request — `verifyAccessToken`
confirms the client still exists, so there is no window where a revoked client
keeps working until its token expires. The client must sign in again to return.

Clients authorized before Courier recorded ownership appear in a separate group;
they cannot be attributed retroactively, and re-authorizing one adopts it.

## Config File

Location: `~/.config/email-courier/accounts.json`

### Single Account

```json
{
  "accounts": [
    {
      "name": "you@fastmail.com",
      "displayName": "Personal",
      "token": "fmu1-your-api-token",
      "caldav": {
        "password": "your-app-password"
      }
    }
  ],
  "defaultAccount": "you@fastmail.com"
}
```

### Multi-Account

```json
{
  "accounts": [
    {
      "name": "personal@fastmail.com",
      "displayName": "Personal",
      "token": "fmu1-personal-token",
      "caldav": {
        "password": "personal-app-password"
      }
    },
    {
      "name": "work@company.com", 
      "displayName": "Work",
      "token": "fmu1-work-token",
      "caldav": {
        "password": "work-app-password"
      }
    }
  ],
  "defaultAccount": "personal@fastmail.com"
}
```

Local stdio clients can switch accounts at runtime using either display name or email:
```
"Switch to Work"
"Switch to work@company.com"
```

For remote stateless HTTP clients, pass the optional `account` parameter
directly to any email, mailbox, contact, calendar, or task tool:

```json
{
  "account": "Work",
  "startAfter": "2026-07-24T00:00:00-07:00",
  "startBefore": "2026-07-25T00:00:00-07:00",
  "limit": 20
}
```

The selector accepts a display name or email and affects only that tool call.
If omitted, Courier uses the persisted default. `switch_account` remains useful
for stateful local clients, but its selection lasts only for its own request in
stateless HTTP mode. Use the setup UI’s **Set as default** option only when the
persisted default for future requests should change.

### Full Account Schema

```json
{
  "name": "email@fastmail.com",
  "displayName": "Personal",
  "token": "fmu1-...",
  "caldav": {
    "password": "app-password",
    "username": "optional-override@example.com",
    "serverUrl": "https://caldav.fastmail.com"
  }
}
```

## CalDAV Configuration

CalDAV is used for calendar events and tasks. It requires an **app password**, not an API token.

### Why App Passwords?

- JMAP uses Bearer tokens (modern, scoped)
- CalDAV uses HTTP Basic Auth (legacy protocol)
- Fastmail generates app passwords specifically for this

### CalDAV-Only Setup

If you only need calendar features:

```bash
export COURIER_EMAIL="you@fastmail.com"
export COURIER_CALDAV_PASSWORD="your-app-password"
```

Note: You'll still need the JMAP token for email features.

## Precedence

1. Environment variables (highest priority)
2. Config file (`accounts.json`)
3. JMAP auto-discovery

## Remote Hosting (Streamable HTTP)

To run Courier as a remote HTTP server (while keeping local `stdio` as the default), set:

```bash
export MCP_TRANSPORT="http"
export MCP_HTTP_HOST="0.0.0.0"
export MCP_HTTP_PORT="3333"
export MCP_HTTP_PATH="/mcp"
```

For safer host validation when binding to `0.0.0.0`, set allowed hosts:

```bash
export MCP_HTTP_ALLOWED_HOSTS="mydomain.com,localhost"
```

## Authentication (Remote)

### Option A: OIDC (Recommended)

In this mode **Courier is its own OAuth authorization server**. MCP clients
register with Courier, and Courier issues its own access and refresh tokens. The
identity provider is used for exactly one thing: authenticating the human at
login time.

```
MCP client ──register / authorize / token──► Courier
                                               │
       your browser ──sign in────────────────► └──► identity provider
```

This matters in practice. The provider is contacted **only from the end user's
browser**, never from an MCP client's network — so per-tenant client limits and
any network filtering in front of your provider cannot break a connection.
Clients need no configuration: any client speaking MCP OAuth discovers and
registers itself.

Use any OIDC provider (Google, Okta, Azure AD, Keycloak, etc.). Multi-user
access is controlled by the allowlist.

```bash
export MCP_AUTH_MODE="oidc"
export MCP_PUBLIC_URL="https://courier.example.com"
export MCP_OIDC_ISSUER_URL="https://accounts.google.com"
export MCP_OIDC_CLIENT_ID="your-client-id"
export MCP_OIDC_CLIENT_SECRET="your-client-secret"
export MCP_ALLOWED_USERS="you@example.com,partner@example.com"
export MCP_TOKEN_SECRET="$(openssl rand -hex 32)"
```

Register **both** redirect URIs with your provider:

| URI | Used by |
| --- | --- |
| `${MCP_PUBLIC_URL}/auth/callback` | the `/ui` setup page |
| `${MCP_PUBLIC_URL}/auth/mcp/callback` | the MCP client authorization flow |

`MCP_PUBLIC_URL` must be the externally reachable HTTPS URL for your server; it
is what the OAuth metadata, the token audience and the redirect URIs are all
derived from, so they cannot drift apart.

Do **not** add `offline_access` to `MCP_OIDC_SCOPES`. Courier needs no refresh
token from the provider — it only reads an ID token once per interactive login,
then issues its own tokens.

#### Client registration

`POST /register` is unauthenticated, as RFC 7591 requires. New registrations are
provisional: they expire after 30 minutes and are capped, with the oldest
evicted first. A client becomes permanent only once an allowlisted user
completes an authorization with it, and permanent clients are never evicted. So
an anonymous caller cannot displace a client you actually use, and registering
grants nothing on its own — a token still requires passing both the provider
login and the allowlist.

### Option B: Auth Proxy (Advanced)

Use an external auth proxy (Cloudflare Access, oauth2-proxy, nginx auth_request). The proxy must inject headers for the authenticated user.

```bash
export MCP_AUTH_MODE="proxy"
export MCP_AUTH_PROXY_EMAIL_HEADER="x-auth-email"
export MCP_ALLOWED_USERS="you@example.com,wife@example.com"
```

## Encrypted Vault

Remote mode stores Fastmail credentials per user in an encrypted vault.

```bash
export COURIER_VAULT_KEY="base64-or-hex-32-byte-key"
export COURIER_VAULT_FILE="/data/email-courier/vault.json"
```

The key must be 32 bytes (base64 or 64 hex chars). Store it securely (env var or secret manager).
Vault mutations are serialized per file and committed with atomic renames, so
simultaneous requests cannot overwrite another user’s update.

## Security Best Practices

- Never commit tokens to git
- Use `chmod 600` on config files
- Prefer environment variables in CI/CD
- Rotate app passwords periodically
