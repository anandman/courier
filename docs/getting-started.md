# Getting Started

This guide walks through setting up Courier for use with AI clients.

## Prerequisites

- Node.js 18+
- A Fastmail account
- An MCP-capable client — see [Connect a client (local)](#connect-a-client-local)
  and [Connect a client (remote)](#connect-a-client-remote)

## Installation

```bash
git clone https://github.com/anandman/email-courier.git
cd email-courier
npm install
npm run build
```

## Fastmail credentials

### JMAP API token (for email)

1. Log in to [Fastmail](https://www.fastmail.com)
2. Go to **Settings → Privacy & Security → Integrations**
3. Under **API tokens**, click **New API token**
4. Name it (e.g., "Courier") and select scopes:
   - `Email` — read/write email
   - `Contacts` — for contact tools
5. Copy the token (starts with `fmu1-`)

### CalDAV app password (for calendar/tasks)

> **Note:** CalDAV uses a different auth mechanism than JMAP, so it needs its own
> credential.

1. In Fastmail **Settings → Privacy & Security → Integrations**
2. Scroll to **App passwords** → **New App Password**
3. Name it (e.g., "Courier CalDAV")
4. Copy the generated password

## Choose a mode

Courier runs two ways. Pick one before going further — the setup differs
completely.

| | **Local** | **Remote** |
|---|---|---|
| Transport | `stdio` | Streamable HTTP |
| Runs | as a subprocess of the client | as a long-lived service |
| Credentials | env vars or a config file on disk | encrypted vault, added per user via `/ui` |
| Users | just you | multiple, gated by an allowlist |
| Works with | desktop and CLI clients on the same machine | those, plus web and mobile clients |

If you only use one machine, local is simpler. If you want Fastmail in a web or
phone client, or to share with someone else, you need remote.

---

# Local mode

## Configure credentials

> Local mode only. In remote mode credentials live in the encrypted vault
> instead — see [Remote mode](#remote-mode).

### Option A: Environment variables (simple)

```bash
export COURIER_API_TOKEN="fmu1-your-token-here"
export COURIER_EMAIL="you@fastmail.com"
export COURIER_CALDAV_PASSWORD="your-app-password"  # optional, for calendar
```

### Option B: Config file (multi-account)

Create `~/.config/email-courier/accounts.json`:

```json
{
  "accounts": [
    {
      "name": "you@fastmail.com",
      "token": "fmu1-your-token-here",
      "caldav": {
        "password": "your-app-password"
      }
    }
  ],
  "defaultAccount": "you@fastmail.com"
}
```

Secure the file:

```bash
chmod 600 ~/.config/email-courier/accounts.json
```

## Connect a client (local)

Each client launches Courier as a subprocess. Use the absolute path to
`dist/index.js`.

### Anthropic — Claude Code

```bash
claude mcp add email-courier -- node /path/to/email-courier/dist/index.js
```

Add `--scope user` to make it available in every project rather than just the
current one.

### Anthropic — Claude Desktop

Local servers are configured by file. Add to
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "email-courier": {
      "command": "node",
      "args": ["/path/to/email-courier/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop afterwards.

### OpenAI — Codex (CLI and desktop)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.email-courier]
command = "node"
args = ["/path/to/email-courier/dist/index.js"]
```

### Google — Antigravity

Add Courier through Antigravity's MCP server settings, using `node` as the
command and the absolute path to `dist/index.js` as the argument. (Gemini CLI is
no longer the supported path for MCP; use Antigravity.)

---

# Remote mode

## Run the server

```bash
export MCP_TRANSPORT="http"
export MCP_HTTP_HOST="127.0.0.1"
export MCP_HTTP_PORT="3333"
export MCP_HTTP_PATH="/mcp"
node dist/index.js
```

Put it behind HTTPS — a reverse proxy, Cloudflare Tunnel, or Tailscale Funnel.
Clients require HTTPS for anything but loopback. If you bind to `0.0.0.0`, set
`MCP_HTTP_ALLOWED_HOSTS` to restrict which `Host` headers are accepted.

## Multi-user access (OIDC + vault)

```bash
export MCP_AUTH_MODE="oidc"
export MCP_PUBLIC_URL="https://courier.example.com"
export MCP_OIDC_ISSUER_URL="https://accounts.google.com"
export MCP_OIDC_CLIENT_ID="your-client-id"
export MCP_OIDC_CLIENT_SECRET="your-client-secret"
export MCP_ALLOWED_USERS="you@example.com,partner@example.com"
export MCP_TOKEN_SECRET="$(openssl rand -hex 32)"
export COURIER_VAULT_KEY="base64-or-hex-32-byte-key"
```

Register **both** redirect URIs with your identity provider:

- `https://courier.example.com/auth/callback` — the `/ui` setup page
- `https://courier.example.com/auth/mcp/callback` — the client authorization flow

Courier is its own OAuth authorization server: clients register with Courier and
it issues its own tokens, while your identity provider only signs users in. See
[Configuration](configuration.md#option-a-oidc-recommended) for the full model.

Then open `https://courier.example.com/ui`, sign in, and add your Fastmail
credentials. Each user does this once, and each user's credentials are stored
encrypted separately.

## Connect a client (remote)

Every client below takes the same server URL — `https://courier.example.com/mcp`
— and needs **no other configuration**. Courier supports dynamic client
registration, so clients register themselves. On first use each one opens a
browser for you to sign in; only users in `MCP_ALLOWED_USERS` are granted a
token.

### Anthropic — claude.ai, Claude Desktop, mobile

Add it once from the web and it appears on every Anthropic surface, since
connectors are stored on your account.

1. Go to **Settings → Connectors**
2. **Add custom connector**
3. Paste `https://courier.example.com/mcp`
4. Click **Connect** and complete the sign-in

> If your provider requires a pre-registered client, "Advanced settings" accepts
> an OAuth Client ID and secret. With Courier you should not need this — it
> registers clients itself.

### Anthropic — Claude Code

```bash
claude mcp add --transport http email-courier https://courier.example.com/mcp
```

Then run `/mcp` inside Claude Code to trigger the sign-in.

### OpenAI — ChatGPT (web, desktop, mobile)

1. Go to **Settings → Connectors**
2. Add a custom connector with `https://courier.example.com/mcp`
3. Complete the sign-in when prompted

### OpenAI — Codex (CLI and desktop)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.email-courier]
url = "https://courier.example.com/mcp"
```

### Google — Antigravity

Add the server URL through Antigravity's MCP settings. It performs the same
registration and browser sign-in as the others.

> **Note:** Antigravity is the supported Google path for MCP. Gemini's own CLI
> and apps do not currently connect to remote MCP servers.

---

## Verify it works

Ask your client:

```
"List my mailboxes"
"Search for unread emails from the last week"
"What tasks do I have?"
```

If a tool reports that no account is configured, open `/ui` on the server (remote
mode) or check your credentials (local mode).

## Next steps

- [Configuration Guide](configuration.md) — multi-account, auth, and vault options
- [Tools Reference](tools.md) — all 36 tools
- [Examples](examples.md) — common prompts and workflows
