# Tools Reference

Complete reference for all MCP tools provided by Courier.

## Permissions

Every tool is offered to every client. What a client may actually *do* with one
is a per-client setting, enforced when the tool is called:

| Tier | Effect |
|------|--------|
| Allow | Runs. |
| Ask first | Asks a person through MCP elicitation, and refuses if nobody can be asked. Requires a client that supports elicitation over a session; it is not reachable on the stateless HTTP transport today. |
| Block | Refused, with an explanation naming the setting that would change it. |

Defaults divide on **reversibility**. Reads and changes a person can undo run
freely; anything that cannot be taken back is blocked until you grant it to a
specific client in Courier's settings:

- **Blocked by default:** `send_email`, `forward_email` (no unsend),
  `delete_mailbox`, `delete_contact`, `delete_event`, `delete_task`.
- **Allowed by default:** everything else, including `delete_emails` — which
  moves mail to Trash rather than destroying it.

A tool Courier does not recognise is blocked until classified.

Note that `create_event` and `update_event` are allowed and accept
`notify: true`, which emails attendees. The tool holds that behind a deliberate
argument and defaults it off, but a client permitted to create events can still
pass it. Block those two for any client where that matters.

## Token-Smart Usage

Most email tools are designed to minimize tokens if used in the right order:

- Use `search_emails` with filters (`after`, `before`, `isUnread`, `mailbox`, `limit`) to get a small list of candidates.
- `search_emails` returns **headers + snippet only**, not full bodies.
- Use `get_email` only for the specific messages you need to read in full (it returns full body + attachments and is token-expensive).

## Account Management

Every email, mailbox, contact, calendar, and task tool accepts an optional
`account` parameter. Pass a configured display name or email to target that
account for one call; omit it to use the persisted default. This is the
recommended selection mechanism for stateless HTTP clients.

### list_accounts
List all configured Fastmail accounts.

**Parameters:** None

**Returns:** Array of accounts with current active indicator.

---

### switch_account
Select a different configured account in the current client context. This does
not change the user-wide persisted default. In stateless HTTP mode the
selection ends with the `switch_account` request, so pass `account` directly to
the target tool instead. Use the setup UI to change the default used by new
requests.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Yes | Account name (email) to switch to |

---

### get_current_account
Get the currently active account.

**Parameters:** None

---

## Email - Browse

### list_mailboxes
List all mailboxes/folders (Inbox, Sent, Drafts, etc.).

**Parameters:** None

**Returns:** Array of mailboxes with id, name, role, counts.

---

### create_mailbox
Create a new mailbox/folder.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Name of the folder to create |
| `parentId` | string | No | Optional ID of the parent folder (for nesting) |

---

### rename_mailbox
Rename an existing mailbox/folder.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the mailbox to rename |
| `name` | string | Yes | New folder name |

---

### delete_mailbox
Delete an existing mailbox/folder.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the mailbox to delete |
| `onDestroyRemoveEmails` | boolean | No | If true, deletes emails from the mailbox instead of failing if not empty |

---

### move_mailbox
Move a mailbox/folder under a new parent (reorganize hierarchy).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the mailbox to move |
| `parentId` | string | Yes (Nullable) | ID of the new parent mailbox, or null for root level |

---

### get_mailbox_details
Retrieve detailed metadata (total email/thread count, unread email/thread count) for a mailbox.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the mailbox |

---

### set_mailbox_role
Set or clear the standard role of a mailbox.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the mailbox |
| `role` | string | Yes (Nullable) | Role to set (e.g. `inbox`, `archive`, `trash`) or null to clear role |

---

### search_emails
Search emails with filters.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mailbox` | string | No | Mailbox name to search in |
| `from` | string | No | Filter by sender |
| `to` | string | No | Filter by recipient |
| `subject` | string | No | Filter by subject |
| `body` | string | No | Full-text search in body |
| `after` | string | No | Emails after date (ISO 8601) |
| `before` | string | No | Emails before date (ISO 8601) |
| `isUnread` | boolean | No | Filter by read status |
| `isFlagged` | boolean | No | Filter by flagged status |
| `limit` | number | No | Max results (default: 20) |

**Returns:** Lightweight results (headers + snippet). Does **not** include full body.

---

### get_email
Get full email content by ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailId` | string | Yes | Email ID to retrieve |

**Returns:** Full email with headers, body, attachments. This is token-expensive; prefer `search_emails` first.

---

## Email - Send

### send_email
Compose and send an email.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `to` | string[] | Yes | Recipient addresses |
| `subject` | string | Yes | Email subject |
| `body` | string | Yes | Email body (text) |
| `cc` | string[] | No | CC recipients |
| `bcc` | string[] | No | BCC recipients |

---

### forward_email
Forward an email with optional comment.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailId` | string | Yes | Email to forward |
| `to` | string[] | Yes | Forward recipients |
| `comment` | string | No | Comment to add |

---

## Email - Organize

### move_emails
Move emails to a mailbox.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailIds` | string[] | Yes | Emails to move |
| `mailbox` | string | Yes | Destination mailbox |

---

### delete_emails
Delete emails (move to trash).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailIds` | string[] | Yes | Emails to delete |

---

### mark_emails
Mark emails as read/unread or flagged/unflagged.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailIds` | string[] | Yes | Emails to mark |
| `isRead` | boolean | No | Mark as read/unread |
| `isFlagged` | boolean | No | Mark as flagged/unflagged |

---

### tag_emails
Add or remove keywords/labels.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `emailIds` | string[] | Yes | Emails to tag |
| `addKeywords` | string[] | No | Keywords to add |
| `removeKeywords` | string[] | No | Keywords to remove |

## Contacts (RFC 9610)

### list_address_books
List contact address books.

**Parameters:** None

**Returns:** Array of address books containing id, name, parentId, and isDefault.

---

### search_contacts
Search contacts.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `text` | string | Yes | Search term (matches name, email, phone number, etc.) |
| `limit` | number | No | Max results to return (default 50) |

---

### get_contact
Fetch details for contacts by their IDs.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | string[] | Yes | List of contact IDs to retrieve |

---

### create_contact
Create a new contact in an address book.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `addressBookId` | string | Yes | ID of the address book to create the contact in |
| `fullName` | string | Yes | Full name of the contact |
| `email` | string | No | Email address |
| `phone` | string | No | Phone number |
| `company` | string | No | Company or organization name |
| `jobTitle` | string | No | Job title |
| `notes` | string | No | Notes or memo |

---

### update_contact
Update fields on an existing contact card.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the contact to update |
| `fullName` | string | No | Updated full name |
| `email` | string | No | Updated email address |
| `phone` | string | No | Updated phone number |
| `company` | string | No | Updated company/org name |
| `jobTitle` | string | No | Updated job title |
| `notes` | string | No | Updated notes or memo |

---

### delete_contact
Delete a contact by ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | ID of the contact to delete |

---

## Calendar

### list_calendars
List all calendars.

**Parameters:** None

**Returns:** Calendars with URL, name, color, task/event support.

---

## Tasks (VTODO)

### list_tasks
List tasks with filters.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `calendarUrl` | string | No | Filter to calendar |
| `status` | string[] | No | Filter by status (`needs-action`, `in-process`, `completed`, `cancelled`) |
| `dueBefore` | string | No | Due before date |
| `dueAfter` | string | No | Due after date |
| `includeCompleted` | boolean | No | Include completed (default: false) |

---

### get_task
Get task details.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskUrl` | string | Yes | Task URL |

---

### create_task
Create a new task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `summary` | string | Yes | Task title |
| `calendarUrl` | string | No | Calendar to create in |
| `description` | string | No | Details |
| `due` | string | No | Due date (ISO 8601) |
| `priority` | number | No | Priority 1-9 |
| `categories` | string[] | No | Tags |

---

### update_task
Update an existing task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskUrl` | string | Yes | Task URL |
| `summary` | string | No | New title |
| `description` | string | No | New description |
| `due` | string | No | New due date |
| `status` | string | No | New status |
| `priority` | number | No | New priority |

---

### complete_task
Mark a task complete.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskUrl` | string | Yes | Task URL |

---

### delete_task
Delete a task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `taskUrl` | string | Yes | Task URL |

---

## Calendar Events (VEVENT)

### list_events
List calendar events.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `calendarUrl` | string | No | Filter to calendar |
| `startAfter` | string | No | Events starting after (ISO 8601) |
| `startBefore` | string | No | Events starting before |
| `limit` | number | No | Max results |

---

### get_event
Get event details.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `eventUrl` | string | Yes | Event URL |

---

### create_event
Create a calendar event.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `summary` | string | Yes | Event title |
| `start` | string | Yes | Start time (ISO 8601) |
| `calendarUrl` | string | No | Calendar to create in |
| `end` | string | No | End time |
| `location` | string | No | Location |
| `description` | string | No | Details |
| `status` | string | No | `tentative`, `confirmed`, `cancelled` |
| `recurrenceRule` | string | No | RRULE (e.g., `FREQ=WEEKLY;BYDAY=MO`) |

---

### update_event
Update an event.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `eventUrl` | string | Yes | Event URL |
| `summary` | string | No | New title |
| `start` | string | No | New start time |
| `end` | string | No | New end time |
| `location` | string | No | New location |
| `status` | string | No | New status |

---

### delete_event
Delete an event.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `eventUrl` | string | Yes | Event URL |
