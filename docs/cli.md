# Courier CLI

`courier` is both halves of this project: the MCP server, and a client for it.

```bash
courier mcp --http                  # run the server
courier search-emails --query tax   # call a tool on a running server
```

The client half exists so that a consumer — a script, a cron job, another agent
— can use Courier's tools without holding a copy of your mail credentials. It
authorizes over OAuth against a running Courier and stores a refresh token. The
JMAP API token and the DAV app password stay on the server, in one copy each.

## Authorizing a machine

```bash
courier auth login --server https://your-courier.example/mcp
```

This registers the CLI as an OAuth client (RFC 7591), opens your browser,
catches the redirect on a local port, and stores a refresh token in
`~/.config/courier/cli-credentials.json`, mode 0600. Nothing to copy or paste.

Once one server is stored, `--server` is optional — the CLI uses it. With two
or more stored, `--server` is required rather than guessed. `COURIER_SERVER`
works too.

A login must be completed within **10 minutes** of starting it: that is how
long the stored PKCE verifier stays usable, and it matches the window Courier
itself allows between `/authorize` and the identity provider's callback.

### When your browser is on a different machine

```bash
courier auth login --remote
```

Your browser goes to a Courier page that displays the authorization code, and
you paste it back. Use this over SSH, mosh, Eternal Terminal, or from a
container.

Nothing detects this for you, deliberately. `SSH_CONNECTION` is unset under
mosh and most other remote shells, and `DISPLAY` only says a screen exists on
the machine — not that anyone is sitting at it. A flow that guessed wrong would
fail in the worst available way: the authorization succeeds, the server issues
a code, the redirect goes to a loopback port on the wrong host, and all you see
is a command that waits and then times out.

**You do not have to remember the flag.** The default accepts a paste too. If
your browser lands on a `127.0.0.1` page that cannot be reached, the
authorization already worked and the code is in the address bar — paste that
address at the prompt and the login completes. `--remote` makes the round trip
tidy rather than making it possible.

Displaying the code is safe because Courier requires PKCE: the code is
single-use, expires in five minutes, and can only be exchanged by a client
holding the verifier whose hash was sent with the authorization request — which
never leaves the machine running the CLI.

### Logging in without a terminal

With no terminal there is nobody to prompt, so the flow splits in two:

```bash
courier auth login                  # prints a URL, exits 0
courier auth login --code "<code>"  # finishes with the code Courier displayed
```

The verifier and the state are persisted between the two, so the halves need
not share a process, a terminal, or a session — within the 10-minute window.

```bash
courier auth status      # what is stored, and when the access token expires
courier auth list        # every known server, and whether it is authorized
courier auth logout      # forget one server
```

`auth list` reports `authorized` per server rather than just naming it. A
registration is stored as soon as a login *starts*, and kept even if the login
is abandoned — deliberately, so a retry reuses the `client_id` instead of
stranding another provisional registration on the server. A bare list of names
would read as "authorized" when it only means "known".

`auth status` exits `3` when nothing is stored, so a script can test for a
usable credential without parsing anything.

## Calling tools

Every tool Courier offers is a subcommand, with dashes or underscores:

```bash
courier search-emails --query invoice --mailbox Inbox --limit 20
courier read-thread --thread-id AkaQuLV6q1YJ
courier changes-since --state 'u123' --mailboxes Inbox --mailboxes Archive
```

Flags are derived from the server's own tool schemas, so they never drift from
what the server accepts. `courier tools` lists what a server offers; `courier
help <tool>` shows one tool's flags.

- Repeat a flag for a list: `--mailboxes Inbox --mailboxes Archive`
- Booleans: `--include-bodies`, `--no-include-bodies`, or `--quote=false`
- Structure: pass JSON — `--filter '{"before":"2026-01-01"}'`
- Values are never split on commas, so a query containing one still means what
  it says.
- `--args-json '{...}'` supplies a base argument object; flags override its keys.

Results go to stdout as JSON, pretty-printed on a terminal and compact when
piped. Everything a person reads goes to stderr.

### Tools that change things need `--yes`

```bash
courier draft-reply --email-id StnZCocGyMEV --body "Sounds good." --yes
```

Anything that is not a read requires `--yes`, or an interactive confirmation
when there is a terminal. Without either, the command exits `5` and does
nothing. A script that has the authority to send mail says so with `--yes`;
one that does not cannot send by omission.

The list enumerates reads, so a tool added to the server later is gated until
it is classified. The CLI deliberately implements no *deny* — refusing a tool
outright is a per-client policy decision, and it belongs to the server.

### Paging

`search_emails` returns at most 100 matches and reports `total`, `position`,
`returned` and `hasMore`. To walk the whole set:

```bash
courier search-emails --query tax --all
```

`--all` is all or nothing. If any page fails, or the page ceiling
(`--max-pages`, default 50) is reached first, the pages already collected are
**discarded** and the command exits `9`. You never receive a partial set that
looks complete.

It also asks for the largest page the tool offers, rather than the per-call
default. That default is tuned for a model paying per token, which is the wrong
trade once you have said you want everything: a consumer measured 434 messages
at 22 requests with the small default against 5 requests at the large one — and
more importantly, the small page size made the ceiling bind at 1000 results
instead of 5000. Raise `--max-pages` for sets larger than that.

## Running it from cron or systemd

```ini
[Service]
Environment=PATH=/home/you/.nvm/versions/node/v24.14.0/bin:/usr/bin:/bin
ExecStart=/home/you/.nvm/versions/node/v24.14.0/bin/courier search-emails ...
```

**Set `PATH` explicitly, including the directory `node` lives in.** `courier`
is a Node shim with `#!/usr/bin/env node`, so an absolute path to the shim is
not enough — the *interpreter* must be findable too. `systemd --user` does not
inherit your login shell's `PATH`, and neither does cron, so a CLI that works
perfectly in your terminal fails there with `ENOENT`.

This is worth knowing because of how it presents: a consumer hit it and its own
health reporting said "mail unavailable", which was true and sent everyone
looking at credentials and the network. Nothing about `ENOENT` on a missing
interpreter resembles its cause.

Point `COURIER_CLI_FILE` at a path belonging to that service, too — see
[Several consumers on one machine](#several-consumers-on-one-machine).

## Several consumers on one machine

Credentials are keyed by file, not by process. Two services running as the same
Unix user share `~/.config/courier/cli-credentials.json` unless told otherwise
— which means they share one OAuth registration, one token, and one identity as
far as the server is concerned.

Give each its own:

```bash
export COURIER_CLI_FILE=~/.config/my-service/courier-credentials.json
export COURIER_SERVER=https://your-courier.example/mcp
courier auth login --remote
```

Each file gets its own `client_id` and refresh token, so the server can tell
them apart — which is what lets you revoke one without touching the others, and
what per-client permissions key on.

To provision a credential for a service that cannot run an interactive login,
run the login yourself with that file's path set. One command, one paste; the
service then just reads the file.

## A note on replies and Apple Mail

`courier draft-reply` writes correct threading headers, but whether the sent
message keeps them depends on the client you send from: **macOS Mail preserves
them, iOS Mail does not**, and on macOS a formatting change (plain text to a
bulleted list) loses them too. See
[Tools Reference](tools.md#replies-apple-mail-and-which-device-you-send-from).

`threadingHeadersWritten` in the result describes the draft, not the sent
message. It is named that way because it used to be called `threaded`, and a
consumer reasonably read a true statement about the draft as a promise about
the mail.

## Exit codes

The exit code is the contract. `courier exit-codes` prints the table below as
JSON, so a consumer can assert against the table it was written for.

| Code | Name | Meaning |
|------|------|---------|
| 0 | `ok` | The server answered the question, in full. stdout holds the result. |
| 1 | `internal` | A defect in the CLI itself. |
| 2 | `usage` | Bad command line. Nothing was sent. Checked *before* credentials, so a typo never reports as an auth problem. |
| 3 | `no-auth` | No stored credential. Run `courier auth login`. |
| 4 | `auth-rejected` | The credential was refused and could not be renewed. Something was revoked. |
| 5 | `forbidden` | Authenticated but not permitted, or confirmation was required and unavailable. |
| 6 | `unreachable` | No answer could be obtained. **The only code worth retrying unchanged.** |
| 7 | `tool-error` | The server answered, and the operation failed. |
| 8 | `upstream-auth` | *Reserved.* The server's own mail credential was rejected. Not yet emitted; these arrive as `7`. |
| 9 | `incomplete` | A paged read failed part way. The partial result was discarded. |

### Exit 0 is about the question you asked, not the question you meant

The contract guarantees that a result at exit 0 is complete and real. It cannot
tell you that you asked about the right mailbox.

```bash
courier search-emails --from someclient.com     # total: 0, exit 0
```

That is an honest answer — for the *default* account. If the mail you wanted is
in another one, the zero is correct and useless. **Pass `--account` explicitly
in anything unattended**, rather than relying on the default:

```bash
courier search-emails --from someclient.com --account Work
```

`courier list-accounts` shows which account is current. This is the one hazard
the exit code cannot catch, and "exit 0 means you can trust this" is exactly
what invites it.

One rule produces all of them:

> **Exit 0 means the server answered the exact question asked, completely.
> Every other code prints nothing data-shaped on stdout.**

Not a partial page set, not an empty array, not `{}`. A consumer that pipes
stdout into a cache cannot ingest a failure even if it ignores the exit code
entirely, because there is nothing there to ingest. The corollary is the part
that makes it useful: an empty result *with* exit 0 is trustworthy, and means
zero matches.

That rule is not abstract. A Courier consumer once lost a day of mail
ingestion because its client checked neither `isError` on the MCP envelope nor
a body-level error, so a disabled API token arrived as `total: None,
emails: []` — an empty mailbox rather than a failure. The CLI checks both, so
no consumer has to get that right again.

```bash
courier search-emails --query tax --compact > page.json || exit $?
```

## Running the server

```bash
courier mcp --stdio    # local client over stdin/stdout
courier mcp --http     # remote over Streamable HTTP
courier mcp            # whatever MCP_TRANSPORT says
```

`courier mcp` is the same server as `node dist/index.js`, which continues to
work unchanged — as does the `courier-mcp` executable, if you prefer a
command with no subcommand. Configuration is unchanged; see
[Configuration](configuration.md).

## Environment

| Variable | Purpose |
|----------|---------|
| `COURIER_SERVER` | Default `--server` value. |
| `COURIER_CLI_FILE` | Where the CLI keeps credentials. Defaults to `$XDG_CONFIG_HOME/courier/cli-credentials.json`. |

A server on `localhost` is tried without credentials, since it may legitimately
run with authentication off. A remote server with nothing stored is refused
before a request is made, so a consumer looping on a lost credential does not
leave a new OAuth registration behind on every run.
