/**
 * CalDAV Type Definitions
 * 
 * Types for CalDAV calendar and task (VTODO) operations.
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for CalDAV connection
 */
export interface CalDAVConfig {
    /** Account email address */
    username: string;
    /** App password (NOT API token - CalDAV requires Basic auth) */
    password: string;
    /** CalDAV server URL (defaults to https://caldav.fastmail.com) */
    serverUrl?: string;
}

// ============================================================================
// Calendar Types
// ============================================================================

/**
 * A CalDAV calendar collection
 */
export interface Calendar {
    /** Full URL to the calendar */
    url: string;
    /** Display name of the calendar */
    displayName: string;
    /** Optional description */
    description?: string;
    /** Calendar ctag for change detection */
    ctag?: string;
    /** Calendar color (hex format) */
    color?: string;
    /** Supported component types (VEVENT, VTODO, etc.) */
    components: string[];
    /** Whether this calendar supports tasks */
    supportsTasks: boolean;
}

// ============================================================================
// Task (VTODO) Types
// ============================================================================

/**
 * Task status values per RFC 5545
 */
export type TaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

/**
 * A calendar task (VTODO component)
 */
export interface Task {
    /** Full URL to the task resource */
    url: string;
    /** ETag for concurrency control */
    etag: string;
    /** Unique identifier for the task */
    uid: string;
    /** Task summary/title */
    summary: string;
    /** Detailed description */
    description?: string;
    /** Current status */
    status: TaskStatus;
    /** Priority 1-9 (1=highest, 9=lowest) */
    priority?: number;
    /** Due date/time (ISO 8601) */
    due?: string;
    /** Start date/time (ISO 8601) */
    start?: string;
    /** Completion date/time (ISO 8601) - set when status is 'completed' */
    completed?: string;
    /** Percent complete (0-100) */
    percentComplete?: number;
    /** Categories/tags */
    categories?: string[];
    /** Creation timestamp (ISO 8601) */
    created?: string;
    /** Last modified timestamp (ISO 8601) */
    lastModified?: string;
    /** URL of the calendar containing this task */
    calendarUrl?: string;
}

/**
 * Options for querying tasks
 */
export interface TaskQueryOptions {
    /** Filter to a specific calendar URL */
    calendarUrl?: string;
    /** Filter by status (multiple = OR) */
    status?: TaskStatus[];
    /** Only tasks due before this date */
    dueBefore?: string;
    /** Only tasks due after this date */
    dueAfter?: string;
    /** Include completed tasks (default: false) */
    includeCompleted?: boolean;
}

/**
 * Data for creating a new task
 */
export interface TaskCreate {
    /** Task summary/title (required) */
    summary: string;
    /** Detailed description */
    description?: string;
    /** Due date/time (ISO 8601 or YYYY-MM-DD) */
    due?: string;
    /** Start date/time (ISO 8601 or YYYY-MM-DD) */
    start?: string;
    /** Priority 1-9 (1=highest) */
    priority?: number;
    /** Categories/tags */
    categories?: string[];
    /** Initial status (defaults to 'needs-action') */
    status?: TaskStatus;
}

/**
 * Data for updating an existing task
 */
export interface TaskUpdate {
    /** Updated summary */
    summary?: string;
    /** Updated description */
    description?: string;
    /** Updated due date */
    due?: string | null;
    /** Updated start date */
    start?: string | null;
    /** Updated priority */
    priority?: number | null;
    /** Updated categories */
    categories?: string[];
    /** Updated status */
    status?: TaskStatus;
    /** Updated percent complete */
    percentComplete?: number;
}

// ============================================================================
// Calendar Event (VEVENT) Types
// ============================================================================

/**
 * Event status values per RFC 5545
 */
export type EventStatus = 'tentative' | 'confirmed' | 'cancelled';

/**
 * A calendar event (VEVENT component)
 */
export interface CalendarEvent {
    /** Full URL to the event resource */
    url: string;
    /** ETag for concurrency control */
    etag: string;
    /** Unique identifier for the event */
    uid: string;
    /** Event summary/title */
    summary: string;
    /** Detailed description */
    description?: string;
    /** Current status */
    status: EventStatus;
    /** Event location */
    location?: string;
    /** Start date/time (ISO 8601) */
    start: string;
    /** End date/time (ISO 8601) */
    end?: string;
    /** Whether this is an all-day event */
    allDay: boolean;
    /** Categories/tags */
    categories?: string[];
    /** Creation timestamp (ISO 8601) */
    created?: string;
    /** Last modified timestamp (ISO 8601) */
    lastModified?: string;
    /** URL of the calendar containing this event */
    calendarUrl?: string;
    /** Recurrence rule (RRULE) if repeating */
    recurrenceRule?: string;
    /** Whether this is an expanded recurrence instance */
    isRecurrence?: boolean;
    /** RECURRENCE-ID value for expanded instances (ISO 8601) */
    recurrenceId?: string;
    /** Organizer email */
    organizer?: string;
    /** Attendees */
    attendees?: string[];
}

/**
 * Options for querying events
 */
export interface EventQueryOptions {
    /** Filter to a specific calendar URL */
    calendarUrl?: string;
    /** Only events starting on or after this date (ISO 8601) */
    startAfter?: string;
    /** Only events starting before this date (ISO 8601) */
    startBefore?: string;
    /** Maximum number of events to return */
    limit?: number;
}

/**
 * Data for creating a new event
 */
export interface EventCreate {
    /** Event summary/title (required) */
    summary: string;
    /**
     * People to invite. Recorded on the event in every case.
     *
     * Whether they are *told* is governed by `notify`, which defaults to false:
     * sending calendar invitations is as outward-facing as sending mail, and an
     * agent should not do it as a side effect of creating an event.
     */
    attendees?: string[];
    /**
     * Send invitations to the attendees. Default false.
     *
     * Implemented with RFC 6638 SCHEDULE-AGENT: NONE suppresses the server's
     * iTIP messages, SERVER (the CalDAV default) sends them. Verified against
     * Fastmail on 2026-10-05 with a control -- NONE produced no invitation, the
     * default produced one -- so `notify: false` is a guarantee rather than a
     * hope.
     */
    notify?: boolean;
    /** Address organising the event. Defaults to the account. */
    organizer?: string;
    /** Detailed description */
    description?: string;
    /** Event location */
    location?: string;
    /** Start date/time (ISO 8601 or YYYY-MM-DD for all-day) */
    start: string;
    /** End date/time (ISO 8601 or YYYY-MM-DD for all-day) */
    end?: string;
    /** Categories/tags */
    categories?: string[];
    /** Initial status (defaults to 'confirmed') */
    status?: EventStatus;
    /** Recurrence rule (RRULE format, e.g., 'FREQ=WEEKLY;BYDAY=MO') */
    recurrenceRule?: string;
}

/**
 * Data for updating an existing event
 */
export interface EventUpdate {
    /** Updated summary */
    summary?: string;
    /** Updated description */
    description?: string | null;
    /** Updated location */
    location?: string | null;
    /** Updated start date/time */
    start?: string;
    /** Updated end date/time */
    end?: string | null;
    /** Updated categories */
    categories?: string[];
    /** Updated status */
    status?: EventStatus;
    /** Updated recurrence rule */
    recurrenceRule?: string | null;
}
