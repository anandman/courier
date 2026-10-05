# Architecture

This document describes the design of Courier for contributors and AI assistants.

## Overview

Courier is an MCP server that bridges AI assistants (Claude, Gemini) with Fastmail's email, calendar, and task services.

```
┌─────────────────┐      MCP       ┌───────────────────┐      JMAP      ┌──────────────┐
│  AI Assistant   │◄──────────────►│  Courier │◄──────────────►│   Fastmail   │
│ (Claude/Gemini) │                │    (MCP Server)   │◄──────────────►│   Services   │
└─────────────────┘                └───────────────────┘     CalDAV     └──────────────┘
```

## Protocols

### JMAP (Email)

[JMAP](https://jmap.io/) is Fastmail's modern email protocol (they invented it, now RFC 8620).

**Why JMAP:**
- Efficient batch operations
- Stateless, REST-like
- Rich search and filter
- First-class Fastmail support

**Used for:** All email operations (search, read, send, organize).

### CalDAV (Calendar/Tasks)

[CalDAV](https://en.wikipedia.org/wiki/CalDAV) is the standard calendar/task sync protocol (RFC 4791).

**Why CalDAV:**
- Universal calendar standard
- iCalendar format (VEVENT, VTODO)
- Works with all calendar apps

**Used for:** Calendar events (VEVENT) and tasks (VTODO).

### Why Two Protocols?

- JMAP for Contacts (RFC 9610, Dec 2024) is ratified, so contacts go over JMAP
- JMAP for Calendars is still an Internet-Draft (`draft-ietf-jmap-calendars`),
  so calendar and tasks go over CalDAV until providers expose it
- CalDAV is the de facto standard for calendar sync in the meantime

## Authentication Model

```
┌───────────────────────────────────────────────────────────────┐
│                    Courier                           │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  JMAP Client                       CalDAV Client              │
│  ───────────                       ─────────────              │
│  Bearer Token (fmu1-...)           HTTP Basic Auth            │
│  API Token from Settings           App Password from Settings │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Different credentials because:**
- JMAP uses modern OAuth-style tokens (scoped, revocable)
- CalDAV uses legacy HTTP Basic Auth (protocol requirement)

## Remote Hosting

Courier runs either as a local stdio process or as a multi-user HTTP service.
Over HTTP it is **both the MCP resource server and its own OAuth 2.1
authorization server** — it owns dynamic client registration and issues its own
access and refresh tokens. An external identity provider authenticates humans
and does nothing else.

```
MCP client ──register / authorize / token──► Courier ──► per-user encrypted vault
                                               │
       user's browser ──sign in──────────────► └──► identity provider (OIDC)
```

Two consequences worth understanding:

- The identity provider is reached **only from the user's browser**, never from
  a client's network. Per-tenant client caps and network filtering in front of
  the provider therefore cannot break a connection.
- Nothing about any particular client or provider is encoded in the server. Any
  client that speaks MCP OAuth works with no configuration; the provider is one
  environment variable.

Fastmail credentials are never held by a client. Each user adds their own via
`/ui`, and they are stored encrypted per-user in the vault, keyed by the
identity claim chosen with `MCP_USER_ID_CLAIM`.

Access is gated by `MCP_ALLOWED_USERS`, checked at authorization, on every token
refresh, and on every token verification — registering a client grants nothing
on its own.

See [Configuration](configuration.md) for setup, redirect URIs and the client
registration model.

## Code Structure

```
src/
├── index.ts              # MCP server entry point
├── account-manager.ts    # Multi-account credential management
├── caldav/
│   ├── client.ts         # CalDAV operations (tsdav library)
│   └── types.ts          # Calendar/Task/Event types
├── tools/
│   ├── index.ts          # Tool registry
│   ├── accounts.ts       # Account management tools
│   ├── mailboxes.ts      # Mailbox listing
│   ├── search.ts         # Email search
│   ├── read.ts           # Email reading
│   ├── send.ts           # Email sending
│   ├── organize.ts       # Email organization
│   └── calendar.ts       # Calendar/Task/Event tools
└── (jmap-courier)        # Imported JMAP client library
```

## Extension Points

### Adding New Tools

1. Create handler in `src/tools/your-tool.ts`
2. Define Zod schema for parameters
3. Register in `src/tools/index.ts`
4. Document in `docs/tools.md`

### Adding New Protocols

Pattern for new DAV services:

```typescript
// src/carddav/client.ts
export class FastmailCardDAVClient {
  // Similar pattern to CalDAV client
}
```

---

## Future Roadmap

### CardDAV (Contacts)

Contacts management via CardDAV (similar to CalDAV integration):
- List address books
- Search/Create/Update/Delete contacts
- vCard format (VCF)

**Why CardDAV:** Standard protocol, Fastmail supports it.

### JMAP Calendar/Contacts

If Fastmail adds JMAP support for calendar/contacts:
- Could unify authentication
- Simplified architecture
- Better performance

Monitor [JMAP Calendar spec](https://www.ietf.org/archive/id/draft-ietf-jmap-calendars-10.html).

---

## Design Decisions

### Why MCP?

Model Context Protocol provides:
- Standard tool interface for AI assistants
- Works with Claude, Gemini, others
- Extensible and secure

### Why TypeScript?

- MCP SDK is TypeScript-native
- Type safety for complex types (Email, Event)
- Good async/await support

### Why tsdav for CalDAV?

- Well-maintained TypeScript library
- Handles iCalendar parsing
- Works with Fastmail's CalDAV server

### Why Not a Single Client?

JMAP and CalDAV are fundamentally different:
- Different auth mechanisms
- Different data formats
- Different server URLs

Keeping them separate is cleaner.
