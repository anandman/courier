# Courier

An MCP server that connects AI assistants to your email, contacts, calendar, and
tasks — over JMAP for mail and contacts, CalDAV for calendar and tasks. Tested
against Fastmail; works with any JMAP provider.

## Quick Install

```bash
git clone https://github.com/anandman/courier.git
cd email-courier
npm install
npm run build
```

## Quick Setup

1. **Get API token:** Fastmail → Settings → Privacy & Security → Integrations → API tokens
2. **Set environment:**
   ```bash
   export COURIER_API_TOKEN="fmu1-your-token"
   export COURIER_EMAIL="you@fastmail.com"
   ```
3. **Add to a client.** Claude Code:
   ```bash
   claude mcp add email-courier -- node /path/to/email-courier/dist/index.js
   ```
   Claude Desktop (`claude_desktop_config.json`) and Codex
   (`~/.codex/config.toml`) take the same command and path in their own formats
   — see [Getting Started](docs/getting-started.md#connect-a-client-local).

## Remote Hosting (Optional)

Courier defaults to local `stdio` transport. To host it remotely over Streamable HTTP:

```bash
export MCP_TRANSPORT="http"
export MCP_HTTP_HOST="0.0.0.0"
export MCP_HTTP_PORT="3333"
export MCP_HTTP_PATH="/mcp"
node dist/index.js
```

For multi-user remote hosting, enable OIDC and the encrypted vault:

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

In this mode Courier is its own OAuth authorization server: MCP clients register
with Courier and it issues its own tokens, while your identity provider only
signs users in. Clients need no configuration — any client speaking MCP OAuth
registers itself. Register both `${MCP_PUBLIC_URL}/auth/callback` and
`${MCP_PUBLIC_URL}/auth/mcp/callback` as redirect URIs with your provider.

Open `/ui` on your server to add Fastmail credentials per user.

To connect, give any client the server URL — `https://courier.example.com/mcp` —
and nothing else. In claude.ai, Claude Desktop and ChatGPT that's
**Settings → Connectors → add a custom connector**; in Claude Code it's
`claude mcp add --transport http`; in Codex it's a `url` entry in
`~/.codex/config.toml`. Each opens a browser once to sign in. See
[Getting Started](docs/getting-started.md#connect-a-client-remote).

See [Configuration](docs/configuration.md) for full auth and vault options.

For calendar/tasks, you'll also need an app password. See [Getting Started](docs/getting-started.md).

## Tools

| Category | Tools |
|----------|-------|
| **Accounts** | `list_accounts`, `switch_account`, `get_current_account` |
| **Email** | `list_mailboxes`, `get_mailbox_details`, `create_mailbox`, `rename_mailbox`, `delete_mailbox`, `move_mailbox`, `set_mailbox_role`, `search_emails`, `get_email`, `send_email`, `forward_email` |
| **Organize** | `move_emails`, `delete_emails`, `mark_emails`, `tag_emails` |
| **Contacts** | `list_address_books`, `search_contacts`, `get_contact`, `create_contact`, `update_contact`, `delete_contact` |
| **Calendar** | `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event` |
| **Tasks** | `list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`, `delete_task` |

All email, mailbox, contact, calendar, and task tools accept an optional
`account` display name or email. Use it to target a non-default account for one
stateless HTTP call without changing the persisted default.

## Documentation

- [Getting Started](docs/getting-started.md) - Full setup guide
- [Configuration](docs/configuration.md) - Multi-account, CalDAV options
- [Tools Reference](docs/tools.md) - All 36 tools with parameters
- [Examples](docs/examples.md) - Common prompts
- [Architecture](docs/architecture.md) - Design & future plans

## Security

- Store tokens securely (environment variables or `chmod 600` config)
- Never commit credentials to git
- Use app passwords for CalDAV (not your main password)

## License

MIT - see [LICENSE](LICENSE) for details.
