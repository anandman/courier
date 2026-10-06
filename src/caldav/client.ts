/**
 * CalDAV Client
 * 
 * A CalDAV client for accessing calendars and tasks (VTODO).
 * Uses the tsdav library for CalDAV protocol operations.
 */

import { DAVClient, DAVCalendar, DAVObject } from 'tsdav';
import type {
    CalDAVConfig,
    Calendar,
    Task,
    TaskStatus,
    TaskQueryOptions,
    TaskCreate,
    TaskUpdate,
    CalendarEvent,
    EventStatus,
    EventQueryOptions,
    EventCreate,
    EventUpdate,
} from './types.js';

const DEFAULT_CALDAV_URL = 'https://caldav.fastmail.com';

/**
 * Undoes RFC 5545 line folding.
 *
 * iCalendar splits any line longer than 75 octets, continuing it on the next
 * line after a single space or tab. Every property regex below is line-anchored,
 * so folding breaks them in two different ways: an `ATTENDEE` folded right after
 * `mailto:` still matches but captures an empty string, while one folded
 * anywhere else stops matching at all and is dropped without trace. Long
 * SUMMARY, LOCATION and DESCRIPTION values are truncated at the fold the same
 * way. Unfold once, before anything reads the data.
 */
export function unfoldICalendar(raw: string): string {
    return raw.replace(/(?:\r\n|\r|\n)[ \t]/g, '');
}

/**
 * Decodes an RFC 5545 escaped TEXT value -- the exact inverse of
 * `escapeICalText`, which this client has always applied when writing.
 *
 * Scanning once, left to right, is what keeps an escaped backslash from being
 * re-read as the opening of the next escape: `\\n` is a backslash followed by
 * the letter n, not a newline.
 */
export function decodeICalendarText(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] !== '\\' || i === value.length - 1) {
            out += value[i];
            continue;
        }
        const escaped = value[++i];
        // \n and \N are newlines; \\ \, and \; all stand for themselves.
        out += escaped === 'n' || escaped === 'N' ? '\n' : escaped;
    }
    return out;
}

/**
 * Splits a comma-separated TEXT list without breaking on escaped commas.
 *
 * Splitting has to happen before unescaping: decode first and a `\,` inside a
 * single category becomes an ordinary comma, which then splits that category in
 * two.
 */
export function splitICalendarList(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '\\' && i + 1 < value.length) {
            current += value[i] + value[i + 1];
            i++;
        } else if (value[i] === ',') {
            parts.push(current);
            current = '';
        } else {
            current += value[i];
        }
    }
    parts.push(current);
    return parts;
}

/**
 * Extracts the address from a CAL-ADDRESS property value.
 *
 * `mailto:` is overwhelmingly the common scheme but RFC 5545 does not require
 * it, so match the property generally and strip the scheme afterwards rather
 * than demanding it up front and silently losing anything else.
 */
export function calAddress(value: string): string {
    return value.trim().replace(/^mailto:/i, '');
}

/** Matches a property and its parameters, capturing only the value. */
function propertyPattern(property: string, flags: string): RegExp {
    return new RegExp(`^${property}(?:;[^\\r\\n:]*)?:(.*)$`, flags);
}

/**
 * Splits a VCALENDAR into its individual components of one type.
 *
 * A calendar object is not one event. With `expand: true` the server returns a
 * single object per recurring series containing one VEVENT per occurrence, each
 * carrying its own DTSTART and RECURRENCE-ID -- so a three-day query on a daily
 * camp comes back as one object holding three VEVENTs.
 *
 * Reading such an object as a single event fails twice over: the scalar
 * properties resolve to whichever component appears first, so only the earliest
 * occurrence is reported, while a repeated property like ATTENDEE is gathered
 * across every component at once and arrives multiplied by the number of
 * occurrences. Parse each component separately instead.
 *
 * The non-greedy body stops at the first END, which is what keeps a nested
 * VALARM from swallowing the rest of the enclosing VEVENT.
 */
export function splitComponents(data: string, component: 'VEVENT' | 'VTODO'): string[] {
    const pattern = new RegExp(`BEGIN:${component}\\r?\\n([\\s\\S]*?)END:${component}`, 'g');
    const components: string[] = [];
    let match;
    while ((match = pattern.exec(data)) !== null) {
        components.push(match[1]);
    }
    return components;
}

/**
 * CalDAV client for calendars and tasks
 */
export class CalDAVClient {
    private config: CalDAVConfig;
    private client: DAVClient | null = null;
    private connected = false;

    constructor(config: CalDAVConfig) {
        this.config = {
            ...config,
            serverUrl: config.serverUrl || DEFAULT_CALDAV_URL,
        };
    }

    /**
     * Connect to the CalDAV server
     */
    async connect(): Promise<void> {
        if (this.connected && this.client) {
            return;
        }

        this.client = new DAVClient({
            serverUrl: this.config.serverUrl!,
            credentials: {
                username: this.config.username,
                password: this.config.password,
            },
            authMethod: 'Basic',
            defaultAccountType: 'caldav',
        });

        await this.client.login();
        this.connected = true;
    }

    /**
     * Ensure we're connected before operations
     */
    private async ensureConnected(): Promise<DAVClient> {
        if (!this.connected || !this.client) {
            await this.connect();
        }
        return this.client!;
    }

    /**
     * Get all calendars
     */
    async getCalendars(): Promise<Calendar[]> {
        const client = await this.ensureConnected();
        const davCalendars = await client.fetchCalendars();

        return davCalendars.map((cal) => this.mapCalendar(cal));
    }

    /**
     * Get calendars that support tasks (VTODO)
     */
    async getTaskCalendars(): Promise<Calendar[]> {
        const calendars = await this.getCalendars();
        return calendars.filter((cal) => cal.supportsTasks);
    }

    /**
     * Get all tasks across all calendars or filtered
     */
    async getTasks(options?: TaskQueryOptions): Promise<Task[]> {
        const client = await this.ensureConnected();

        // Determine which calendars to query
        let calendars: Calendar[];
        if (options?.calendarUrl) {
            calendars = [{ url: options.calendarUrl } as Calendar];
        } else {
            calendars = await this.getTaskCalendars();
        }

        const allTasks: Task[] = [];

        for (const calendar of calendars) {
            try {
                const calendarObjects = await client.fetchCalendarObjects({
                    calendar: { url: calendar.url } as DAVCalendar,
                    filters: this.buildVTODOFilter(options),
                });

                for (const obj of calendarObjects) {
                    for (const task of this.parseVTODOs(obj, calendar.url)) {
                        if (this.matchesFilter(task, options)) {
                            allTasks.push(task);
                        }
                    }
                }
            } catch (error) {
                // Skip calendars that error (e.g., no VTODO support)
                console.warn(`Failed to fetch tasks from ${calendar.url}:`, error);
            }
        }

        // Sort by due date (tasks without due date at the end)
        allTasks.sort((a, b) => {
            if (!a.due && !b.due) return 0;
            if (!a.due) return 1;
            if (!b.due) return -1;
            return new Date(a.due).getTime() - new Date(b.due).getTime();
        });

        return allTasks;
    }

    /**
     * Get a single task by URL
     */
    async getTask(taskUrl: string): Promise<Task | null> {
        const client = await this.ensureConnected();

        try {
            const objects = await client.fetchCalendarObjects({
                calendar: { url: this.getCalendarUrlFromTaskUrl(taskUrl) } as DAVCalendar,
                objectUrls: [taskUrl],
            });

            if (objects.length === 0) {
                return null;
            }

            return this.parseVTODOs(objects[0])[0] ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Create a new task
     */
    async createTask(calendarUrl: string, task: TaskCreate): Promise<Task> {
        const client = await this.ensureConnected();

        const uid = this.generateUID();
        const icalData = this.buildVTODO(uid, task);

        const result = await client.createCalendarObject({
            calendar: { url: calendarUrl } as DAVCalendar,
            filename: `${uid}.ics`,
            iCalString: icalData,
        });

        // Fetch the created task to get full details
        const taskUrl = result.url || `${calendarUrl}${uid}.ics`;
        const createdTask = await this.getTask(taskUrl);

        if (!createdTask) {
            // Return a constructed task if fetch fails
            return {
                url: taskUrl,
                etag: '',
                uid,
                summary: task.summary,
                description: task.description,
                status: task.status || 'needs-action',
                priority: task.priority,
                due: task.due,
                start: task.start,
                categories: task.categories,
                created: new Date().toISOString(),
                calendarUrl,
            };
        }

        return createdTask;
    }

    /**
     * Update an existing task
     */
    async updateTask(taskUrl: string, updates: TaskUpdate): Promise<Task> {
        const client = await this.ensureConnected();

        // Fetch current task
        const currentTask = await this.getTask(taskUrl);
        if (!currentTask) {
            throw new Error(`Task not found: ${taskUrl}`);
        }

        // Merge updates
        const updatedTask: TaskCreate = {
            summary: updates.summary ?? currentTask.summary,
            description: updates.description !== undefined ? (updates.description ?? undefined) : currentTask.description,
            due: updates.due !== undefined ? (updates.due ?? undefined) : currentTask.due,
            start: updates.start !== undefined ? (updates.start ?? undefined) : currentTask.start,
            priority: updates.priority !== undefined ? (updates.priority ?? undefined) : currentTask.priority,
            categories: updates.categories ?? currentTask.categories,
            status: updates.status ?? currentTask.status,
        };

        const icalData = this.buildVTODO(currentTask.uid, updatedTask, {
            created: currentTask.created,
            completed: updates.status === 'completed' && !currentTask.completed
                ? new Date().toISOString()
                : currentTask.completed,
            percentComplete: updates.percentComplete ?? currentTask.percentComplete,
        });

        await client.updateCalendarObject({
            calendarObject: {
                url: taskUrl,
                etag: currentTask.etag,
                data: icalData,
            } as DAVObject,
        });

        // Fetch updated task
        const result = await this.getTask(taskUrl);
        return result || { ...currentTask, ...updates } as Task;
    }

    /**
     * Mark a task as complete
     */
    async completeTask(taskUrl: string): Promise<Task> {
        return this.updateTask(taskUrl, {
            status: 'completed',
            percentComplete: 100,
        });
    }

    /**
     * Delete a task
     */
    async deleteTask(taskUrl: string): Promise<void> {
        const client = await this.ensureConnected();

        // Get etag first
        const task = await this.getTask(taskUrl);

        await client.deleteCalendarObject({
            calendarObject: {
                url: taskUrl,
                etag: task?.etag,
            } as DAVObject,
        });
    }

    // =========================================================================
    // Event (VEVENT) Methods
    // =========================================================================

    /**
     * Get calendars that support events (VEVENT)
     */
    async getEventCalendars(): Promise<Calendar[]> {
        const calendars = await this.getCalendars();
        return calendars.filter((cal) => cal.components.includes('VEVENT'));
    }

    /**
     * Get all events across calendars or filtered
     */
    async getEvents(options?: EventQueryOptions): Promise<CalendarEvent[]> {
        const client = await this.ensureConnected();

        // Determine which calendars to query
        let calendars: Calendar[];
        if (options?.calendarUrl) {
            calendars = [{ url: options.calendarUrl } as Calendar];
        } else {
            calendars = await this.getEventCalendars();
        }

        // Build time range for server-side filtering and recurrence expansion.
        // When startAfter/startBefore are provided, use them directly.
        // Otherwise, default to now → +90 days to avoid returning ancient DTSTART values
        // from recurring events (e.g., 1883, 1918, 1970).
        const now = new Date();
        const rangeStart = options?.startAfter || now.toISOString();
        const defaultEnd = new Date(now);
        defaultEnd.setDate(defaultEnd.getDate() + 90);
        const rangeEnd = options?.startBefore || defaultEnd.toISOString();

        const limit = options?.limit || 1000;
        const allEvents: CalendarEvent[] = [];

        for (const calendar of calendars) {
            try {
                const calendarObjects = await client.fetchCalendarObjects({
                    calendar: { url: calendar.url } as DAVCalendar,
                    timeRange: { start: rangeStart, end: rangeEnd },
                    expand: true,
                });

                for (const obj of calendarObjects) {
                    allEvents.push(...this.parseVEVENTs(obj, calendar.url));
                }
            } catch (error) {
                console.warn(`Failed to fetch events from ${calendar.url}:`, error);
            }
        }

        // Sort by start date
        allEvents.sort((a, b) => {
            return new Date(a.start).getTime() - new Date(b.start).getTime();
        });

        // Apply limit after sorting
        return allEvents.slice(0, limit);
    }

    /**
     * Get a single event by URL
     */
    async getEvent(eventUrl: string): Promise<CalendarEvent | null> {
        const client = await this.ensureConnected();

        try {
            const objects = await client.fetchCalendarObjects({
                calendar: { url: this.getCalendarUrlFromTaskUrl(eventUrl) } as DAVCalendar,
                objectUrls: [eventUrl],
            });

            if (objects.length === 0) {
                return null;
            }

            // Fetched by URL without expansion, so this is the series master
            // plus any overrides. The first component is the event itself.
            return this.parseVEVENTs(objects[0])[0] ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Create a new event
     */
    async createEvent(calendarUrl: string, event: EventCreate): Promise<CalendarEvent> {
        const client = await this.ensureConnected();

        const uid = this.generateUID();
        const icalData = this.buildVEVENT(uid, event);

        const result = await client.createCalendarObject({
            calendar: { url: calendarUrl } as DAVCalendar,
            filename: `${uid}.ics`,
            iCalString: icalData,
        });

        const eventUrl = result.url || `${calendarUrl}${uid}.ics`;
        const createdEvent = await this.getEvent(eventUrl);

        if (!createdEvent) {
            return {
                url: eventUrl,
                etag: '',
                uid,
                summary: event.summary,
                description: event.description,
                status: event.status || 'confirmed',
                location: event.location,
                start: event.start,
                end: event.end,
                allDay: event.start.length === 10,
                categories: event.categories,
                created: new Date().toISOString(),
                calendarUrl,
                recurrenceRule: event.recurrenceRule,
            };
        }

        return createdEvent;
    }

    /**
     * Update an existing event
     */
    async updateEvent(eventUrl: string, updates: EventUpdate): Promise<CalendarEvent> {
        const client = await this.ensureConnected();

        const currentEvent = await this.getEvent(eventUrl);
        if (!currentEvent) {
            throw new Error(`Event not found: ${eventUrl}`);
        }

        const updatedEvent: EventCreate = {
            summary: updates.summary ?? currentEvent.summary,
            description: updates.description !== undefined
                ? (updates.description ?? undefined)
                : currentEvent.description,
            location: updates.location !== undefined
                ? (updates.location ?? undefined)
                : currentEvent.location,
            start: updates.start ?? currentEvent.start,
            end: updates.end !== undefined
                ? (updates.end ?? undefined)
                : currentEvent.end,
            categories: updates.categories ?? currentEvent.categories,
            status: updates.status ?? currentEvent.status,
            recurrenceRule: updates.recurrenceRule !== undefined
                ? (updates.recurrenceRule ?? undefined)
                : currentEvent.recurrenceRule,
        };

        const icalData = this.buildVEVENT(currentEvent.uid, updatedEvent, {
            created: currentEvent.created,
        });

        await client.updateCalendarObject({
            calendarObject: {
                url: eventUrl,
                etag: currentEvent.etag,
                data: icalData,
            } as DAVObject,
        });

        const result = await this.getEvent(eventUrl);
        return result || { ...currentEvent, ...updates } as CalendarEvent;
    }

    /**
     * Delete an event
     */
    async deleteEvent(eventUrl: string): Promise<void> {
        const client = await this.ensureConnected();

        const event = await this.getEvent(eventUrl);

        await client.deleteCalendarObject({
            calendarObject: {
                url: eventUrl,
                etag: event?.etag,
            } as DAVObject,
        });
    }

    // =========================================================================
    // Private Helper Methods
    // =========================================================================

    private mapCalendar(davCalendar: DAVCalendar): Calendar {
        const components = davCalendar.components || [];
        // displayName can be string or Record in tsdav types, handle both
        const displayName = typeof davCalendar.displayName === 'string'
            ? davCalendar.displayName
            : 'Untitled';
        return {
            url: davCalendar.url,
            displayName: displayName || 'Untitled',
            description: typeof davCalendar.description === 'string' ? davCalendar.description : undefined,
            ctag: davCalendar.ctag,
            color: davCalendar.calendarColor,
            components,
            supportsTasks: components.includes('VTODO'),
        };
    }

    /** Parses every VTODO in a calendar object, not just the first. */
    private parseVTODOs(obj: DAVObject, calendarUrl?: string): Task[] {
        const raw = obj.data;
        if (!raw || !raw.includes('VTODO')) {
            return [];
        }
        const data = unfoldICalendar(raw);
        const components = splitComponents(data, 'VTODO');
        const sources = components.length > 0 ? components : [data];

        return sources
            .map((component) => this.parseVTODOComponent(component, obj, calendarUrl))
            .filter((task): task is Task => task !== null);
    }

    private parseVTODOComponent(data: string, obj: DAVObject, calendarUrl?: string): Task | null {
        // Parse iCalendar VTODO component
        const getValue = (property: string): string | undefined => {
            const match = data.match(propertyPattern(property, 'mi'));
            return match ? match[1].trim() : undefined;
        };

        /** For TEXT-typed properties, which carry escaped commas and newlines. */
        const getTextValue = (property: string): string | undefined => {
            const value = getValue(property);
            return value === undefined ? undefined : decodeICalendarText(value);
        };

        const getDateValue = (property: string): string | undefined => {
            const value = getValue(property);
            if (!value) return undefined;

            // Handle different date formats
            if (value.includes('T')) {
                // DateTime format: 20240127T120000Z or 20240127T120000
                const year = value.substring(0, 4);
                const month = value.substring(4, 6);
                const day = value.substring(6, 8);
                const hour = value.substring(9, 11);
                const min = value.substring(11, 13);
                const sec = value.substring(13, 15);
                const tz = value.endsWith('Z') ? 'Z' : '';
                return `${year}-${month}-${day}T${hour}:${min}:${sec}${tz}`;
            } else {
                // Date only: 20240127
                const year = value.substring(0, 4);
                const month = value.substring(4, 6);
                const day = value.substring(6, 8);
                return `${year}-${month}-${day}`;
            }
        };

        const uid = getValue('UID');
        const summary = getTextValue('SUMMARY');

        if (!uid || !summary) {
            return null;
        }

        const statusRaw = getValue('STATUS')?.toLowerCase();
        let status: TaskStatus = 'needs-action';
        if (statusRaw === 'completed') status = 'completed';
        else if (statusRaw === 'in-process') status = 'in-process';
        else if (statusRaw === 'cancelled') status = 'cancelled';

        const priorityRaw = getValue('PRIORITY');
        const priority = priorityRaw ? parseInt(priorityRaw, 10) : undefined;

        const percentRaw = getValue('PERCENT-COMPLETE');
        const percentComplete = percentRaw ? parseInt(percentRaw, 10) : undefined;

        const categoriesRaw = getValue('CATEGORIES');
        const categories = categoriesRaw
            ? splitICalendarList(categoriesRaw)
                  .map((c) => decodeICalendarText(c).trim())
                  .filter((c) => c.length > 0)
            : undefined;

        return {
            url: obj.url,
            etag: obj.etag || '',
            uid,
            summary,
            description: getTextValue('DESCRIPTION'),
            status,
            priority: priority && priority > 0 ? priority : undefined,
            due: getDateValue('DUE'),
            start: getDateValue('DTSTART'),
            completed: getDateValue('COMPLETED'),
            percentComplete,
            categories,
            created: getDateValue('CREATED'),
            lastModified: getDateValue('LAST-MODIFIED'),
            calendarUrl,
        };
    }

    private buildVTODO(
        uid: string,
        task: TaskCreate,
        extra?: { created?: string; completed?: string; percentComplete?: number }
    ): string {
        const now = new Date();
        const timestamp = this.formatICalDate(now);
        const lines: string[] = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Courier//CalDAV Client//EN',
            'BEGIN:VTODO',
            `UID:${uid}`,
            `DTSTAMP:${timestamp}`,
            `SUMMARY:${this.escapeICalText(task.summary)}`,
        ];

        if (task.description) {
            lines.push(`DESCRIPTION:${this.escapeICalText(task.description)}`);
        }

        if (task.due) {
            lines.push(`DUE:${this.parseToICalDate(task.due)}`);
        }

        if (task.start) {
            lines.push(`DTSTART:${this.parseToICalDate(task.start)}`);
        }

        if (task.priority !== undefined && task.priority > 0) {
            lines.push(`PRIORITY:${task.priority}`);
        }

        if (task.categories && task.categories.length > 0) {
            lines.push(`CATEGORIES:${task.categories.join(',')}`);
        }

        const status = task.status || 'needs-action';
        lines.push(`STATUS:${status.toUpperCase()}`);

        if (extra?.percentComplete !== undefined) {
            lines.push(`PERCENT-COMPLETE:${extra.percentComplete}`);
        }

        if (extra?.completed) {
            lines.push(`COMPLETED:${this.parseToICalDate(extra.completed)}`);
        }

        if (extra?.created) {
            lines.push(`CREATED:${this.parseToICalDate(extra.created)}`);
        }

        lines.push(`LAST-MODIFIED:${timestamp}`);
        lines.push('END:VTODO');
        lines.push('END:VCALENDAR');

        return lines.join('\r\n');
    }

    private buildVTODOFilter(_options?: TaskQueryOptions): object[] {
        // CalDAV REPORT filter for VTODO components
        return [
            {
                'comp-filter': {
                    _attributes: { name: 'VCALENDAR' },
                    'comp-filter': {
                        _attributes: { name: 'VTODO' },
                    },
                },
            },
        ];
    }

    private matchesFilter(task: Task, options?: TaskQueryOptions): boolean {
        if (!options) return true;

        // Filter by status
        if (options.status && options.status.length > 0) {
            if (!options.status.includes(task.status)) {
                return false;
            }
        }

        // Filter completed tasks
        if (!options.includeCompleted && task.status === 'completed') {
            return false;
        }

        // Filter by due date range
        if (options.dueBefore && task.due) {
            if (new Date(task.due) > new Date(options.dueBefore)) {
                return false;
            }
        }

        if (options.dueAfter && task.due) {
            if (new Date(task.due) < new Date(options.dueAfter)) {
                return false;
            }
        }

        return true;
    }

    private getCalendarUrlFromTaskUrl(taskUrl: string): string {
        // Task URL: https://caldav.fastmail.com/dav/calendars/user/email/calendar/task.ics
        // Calendar URL: https://caldav.fastmail.com/dav/calendars/user/email/calendar/
        const parts = taskUrl.split('/');
        parts.pop(); // Remove task filename
        return parts.join('/') + '/';
    }

    private generateUID(): string {
        // Generate a unique identifier for new tasks
        const random = Math.random().toString(36).substring(2, 15);
        const timestamp = Date.now().toString(36);
        return `${timestamp}-${random}@email-courier`;
    }

    private formatICalDate(date: Date): string {
        return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    }

    private parseToICalDate(dateStr: string): string {
        // Handle ISO format input
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            // Already in iCal format?
            return dateStr;
        }

        // Check if it's a date-only value (no time component in original)
        if (dateStr.length === 10) {
            // YYYY-MM-DD -> YYYYMMDD
            return dateStr.replace(/-/g, '');
        }

        return this.formatICalDate(date);
    }

    private escapeICalText(text: string): string {
        return text
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\n/g, '\\n');
    }

    // =========================================================================
    // VEVENT Helper Methods
    // =========================================================================

    /**
     * Parses every VEVENT in a calendar object.
     *
     * Returns one entry per expanded occurrence, so a recurring series spanning
     * the queried range yields an event per day rather than only its first.
     */
    private parseVEVENTs(obj: DAVObject, calendarUrl?: string): CalendarEvent[] {
        const raw = obj.data;
        if (!raw || !raw.includes('VEVENT')) {
            return [];
        }
        const data = unfoldICalendar(raw);
        const components = splitComponents(data, 'VEVENT');

        // If the markers are missing or malformed, fall back to treating the
        // whole object as one component rather than silently returning nothing.
        const sources = components.length > 0 ? components : [data];

        return sources
            .map((component) => this.parseVEVENTComponent(component, obj, calendarUrl))
            .filter((event): event is CalendarEvent => event !== null);
    }

    private parseVEVENTComponent(
        data: string,
        obj: DAVObject,
        calendarUrl?: string
    ): CalendarEvent | null {
        const getValue = (property: string): string | undefined => {
            const match = data.match(propertyPattern(property, 'mi'));
            return match ? match[1].trim() : undefined;
        };

        /** For TEXT-typed properties, which carry escaped commas and newlines. */
        const getTextValue = (property: string): string | undefined => {
            const value = getValue(property);
            return value === undefined ? undefined : decodeICalendarText(value);
        };

        const getDateValue = (property: string): { value: string; isAllDay: boolean } | undefined => {
            // Check for VALUE=DATE (all-day event)
            const dateOnlyRegex = new RegExp(`^${property};VALUE=DATE:(.*)$`, 'mi');
            const dateOnlyMatch = data.match(dateOnlyRegex);
            if (dateOnlyMatch) {
                const val = dateOnlyMatch[1].trim();
                const year = val.substring(0, 4);
                const month = val.substring(4, 6);
                const day = val.substring(6, 8);
                return { value: `${year}-${month}-${day}`, isAllDay: true };
            }

            // Check for datetime
            const value = getValue(property);
            if (!value) return undefined;

            if (value.includes('T')) {
                const year = value.substring(0, 4);
                const month = value.substring(4, 6);
                const day = value.substring(6, 8);
                const hour = value.substring(9, 11);
                const min = value.substring(11, 13);
                const sec = value.substring(13, 15);
                const tz = value.endsWith('Z') ? 'Z' : '';
                return { value: `${year}-${month}-${day}T${hour}:${min}:${sec}${tz}`, isAllDay: false };
            } else {
                const year = value.substring(0, 4);
                const month = value.substring(4, 6);
                const day = value.substring(6, 8);
                return { value: `${year}-${month}-${day}`, isAllDay: true };
            }
        };

        const uid = getValue('UID');
        const summary = getTextValue('SUMMARY');
        const startInfo = getDateValue('DTSTART');

        if (!uid || !summary || !startInfo) {
            return null;
        }

        const endInfo = getDateValue('DTEND');

        const statusRaw = getValue('STATUS')?.toLowerCase();
        let status: EventStatus = 'confirmed';
        if (statusRaw === 'tentative') status = 'tentative';
        else if (statusRaw === 'cancelled') status = 'cancelled';

        const categoriesRaw = getValue('CATEGORIES');
        const categories = categoriesRaw
            ? splitICalendarList(categoriesRaw)
                  .map((c) => decodeICalendarText(c).trim())
                  .filter((c) => c.length > 0)
            : undefined;

        // Attendees. Empty entries are dropped rather than passed on: an address
        // we failed to read is not an anonymous guest, and a model shown `""`
        // will describe one.
        const attendeeRegex = propertyPattern('ATTENDEE', 'gmi');
        const attendees: string[] = [];
        let attendeeMatch;
        while ((attendeeMatch = attendeeRegex.exec(data)) !== null) {
            const address = calAddress(attendeeMatch[1]);
            if (address) attendees.push(address);
        }

        // Parse organizer
        const organizerMatch = data.match(propertyPattern('ORGANIZER', 'mi'));
        const organizer = organizerMatch ? calAddress(organizerMatch[1]) || undefined : undefined;

        // Parse RECURRENCE-ID (present on expanded recurring event instances)
        const recurrenceIdInfo = getDateValue('RECURRENCE-ID');

        return {
            url: obj.url,
            etag: obj.etag || '',
            uid,
            summary,
            description: getTextValue('DESCRIPTION'),
            status,
            location: getTextValue('LOCATION'),
            start: startInfo.value,
            end: endInfo?.value,
            allDay: startInfo.isAllDay,
            categories,
            created: getDateValue('CREATED')?.value,
            lastModified: getDateValue('LAST-MODIFIED')?.value,
            calendarUrl,
            recurrenceRule: getValue('RRULE'),
            isRecurrence: recurrenceIdInfo !== undefined,
            recurrenceId: recurrenceIdInfo?.value,
            organizer,
            attendees: attendees.length > 0 ? attendees : undefined,
        };
    }

    private buildVEVENT(
        uid: string,
        event: EventCreate,
        extra?: { created?: string }
    ): string {
        const now = new Date();
        const timestamp = this.formatICalDate(now);
        const isAllDay = event.start.length === 10;

        const lines: string[] = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Courier//CalDAV Client//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${timestamp}`,
            `SUMMARY:${this.escapeICalText(event.summary)}`,
        ];

        if (isAllDay) {
            lines.push(`DTSTART;VALUE=DATE:${event.start.replace(/-/g, '')}`);
            if (event.end) {
                lines.push(`DTEND;VALUE=DATE:${event.end.replace(/-/g, '')}`);
            }
        } else {
            lines.push(`DTSTART:${this.parseToICalDate(event.start)}`);
            if (event.end) {
                lines.push(`DTEND:${this.parseToICalDate(event.end)}`);
            }
        }

        if (event.description) {
            lines.push(`DESCRIPTION:${this.escapeICalText(event.description)}`);
        }

        if (event.location) {
            lines.push(`LOCATION:${this.escapeICalText(event.location)}`);
        }

        if (event.categories && event.categories.length > 0) {
            lines.push(`CATEGORIES:${event.categories.join(',')}`);
        }

        // Attendees. SCHEDULE-AGENT decides whether the server emails them
        // (RFC 6638): NONE keeps it silent, SERVER sends iTIP invitations.
        // Verified against Fastmail with a control on 2026-10-05.
        if (event.attendees && event.attendees.length > 0) {
            const organizer = event.organizer || this.config.username;
            if (organizer) {
                lines.push(`ORGANIZER:mailto:${organizer}`);
            }
            const agent = event.notify ? '' : ';SCHEDULE-AGENT=NONE';
            for (const attendee of event.attendees) {
                lines.push(
                    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${agent}:mailto:${attendee}`
                );
            }
        }

        const status = event.status || 'confirmed';
        lines.push(`STATUS:${status.toUpperCase()}`);

        if (event.recurrenceRule) {
            lines.push(`RRULE:${event.recurrenceRule}`);
        }

        if (extra?.created) {
            lines.push(`CREATED:${this.parseToICalDate(extra.created)}`);
        }

        lines.push(`LAST-MODIFIED:${timestamp}`);
        lines.push('END:VEVENT');
        lines.push('END:VCALENDAR');

        return lines.join('\r\n');
    }

    private buildVEVENTFilter(_options?: EventQueryOptions): object[] {
        // CalDAV REPORT filter for VEVENT components
        return [
            {
                'comp-filter': {
                    _attributes: { name: 'VCALENDAR' },
                    'comp-filter': {
                        _attributes: { name: 'VEVENT' },
                    },
                },
            },
        ];
    }

    private matchesEventFilter(event: CalendarEvent, options?: EventQueryOptions): boolean {
        if (!options) return true;

        // Filter by start date range
        if (options.startAfter) {
            if (new Date(event.start) < new Date(options.startAfter)) {
                return false;
            }
        }

        if (options.startBefore) {
            if (new Date(event.start) >= new Date(options.startBefore)) {
                return false;
            }
        }

        return true;
    }
}

// Client cache for connection reuse
const clientCache = new Map<string, CalDAVClient>();

export function getCalDAVClient(config: CalDAVConfig): CalDAVClient {
    const key = config.username;
    let client = clientCache.get(key);

    if (!client) {
        client = new CalDAVClient(config);
        clientCache.set(key, client);
    }

    return client;
}

export function clearCalDAVClientCache(): void {
    clientCache.clear();
}
