/**
 * Calendar and Task Tools for MCP Server
 * 
 * Provides tools for managing calendars, events, and tasks via CalDAV.
 */

import { z } from 'zod';
import { getAccountManager } from '../account-manager.js';
import { getCalDAVClient } from '../caldav/index.js';
import type { Task, TaskCreate, TaskUpdate, TaskStatus, CalendarEvent, EventCreate, EventUpdate } from '../caldav/types.js';

// ============================================================================
// Helper Functions
// ============================================================================

function getClient() {
    const manager = getAccountManager();
    const config = manager.getCalDAVConfig();

    if (!config) {
        throw new Error(
            'CalDAV is not configured. Please set COURIER_CALDAV_PASSWORD environment variable or add caldav configuration to your accounts.json file.'
        );
    }

    return getCalDAVClient(config);
}

// ============================================================================
// List Calendars
// ============================================================================

export const listCalendarsSchema = z.object({});

export async function listCalendars(): Promise<{
    calendars: Array<{
        url: string;
        displayName: string;
        description?: string;
        color?: string;
        supportsTasks: boolean;
    }>;
}> {
    const client = getClient();
    const calendars = await client.getCalendars();

    return {
        calendars: calendars.map((cal) => ({
            url: cal.url,
            displayName: cal.displayName,
            description: cal.description,
            color: cal.color,
            supportsTasks: cal.supportsTasks,
        })),
    };
}

// ============================================================================
// List Tasks
// ============================================================================

export const listTasksSchema = z.object({
    calendarUrl: z.string().optional().describe('Filter to a specific calendar URL to keep results small'),
    status: z
        .array(z.enum(['needs-action', 'in-process', 'completed', 'cancelled']))
        .optional()
        .describe('Filter by task status to reduce results'),
    dueBefore: z.string().optional().describe('Only tasks due before this date (ISO 8601)'),
    dueAfter: z.string().optional().describe('Only tasks due after this date (ISO 8601)'),
    includeCompleted: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include completed tasks (default: false). Keep false to reduce results.'),
});

export async function listTasks(params: z.infer<typeof listTasksSchema>): Promise<{
    tasks: Task[];
    count: number;
}> {
    const client = getClient();
    const tasks = await client.getTasks({
        calendarUrl: params.calendarUrl,
        status: params.status as TaskStatus[],
        dueBefore: params.dueBefore,
        dueAfter: params.dueAfter,
        includeCompleted: params.includeCompleted,
    });

    return {
        tasks,
        count: tasks.length,
    };
}

// ============================================================================
// Get Task
// ============================================================================

export const getTaskSchema = z.object({
    taskUrl: z.string().describe('URL of the task to retrieve (use list_tasks first)'),
});

export async function getTask(params: z.infer<typeof getTaskSchema>): Promise<{
    task: Task | null;
}> {
    const client = getClient();
    const task = await client.getTask(params.taskUrl);

    return { task };
}

// ============================================================================
// Create Task
// ============================================================================

export const createTaskSchema = z.object({
    calendarUrl: z
        .string()
        .optional()
        .describe('Calendar URL to create the task in. If not provided, uses the first task-capable calendar.'),
    summary: z.string().describe('Task title/summary'),
    description: z.string().optional().describe('Detailed description (keep concise if possible)'),
    due: z.string().optional().describe('Due date (ISO 8601 format, e.g., 2024-01-27 or 2024-01-27T18:00:00Z)'),
    start: z.string().optional().describe('Start date (ISO 8601 format)'),
    priority: z
        .number()
        .min(1)
        .max(9)
        .optional()
        .describe('Priority 1-9 (1 is highest priority)'),
    categories: z.array(z.string()).optional().describe('Categories/tags for the task'),
});

export async function createTask(params: z.infer<typeof createTaskSchema>): Promise<{
    task: Task;
    message: string;
}> {
    const client = getClient();

    // Find calendar URL if not provided
    let calendarUrl = params.calendarUrl;
    if (!calendarUrl) {
        const calendars = await client.getTaskCalendars();
        if (calendars.length === 0) {
            throw new Error('No calendars with task support found');
        }
        calendarUrl = calendars[0].url;
    }

    const taskData: TaskCreate = {
        summary: params.summary,
        description: params.description,
        due: params.due,
        start: params.start,
        priority: params.priority,
        categories: params.categories,
    };

    const task = await client.createTask(calendarUrl, taskData);

    return {
        task,
        message: `Task "${params.summary}" created successfully`,
    };
}

// ============================================================================
// Update Task
// ============================================================================

export const updateTaskSchema = z.object({
    taskUrl: z.string().describe('URL of the task to update'),
    summary: z.string().optional().describe('New task title'),
    description: z.string().nullable().optional().describe('New description (null to clear; keep concise)'),
    due: z.string().nullable().optional().describe('New due date (null to clear)'),
    start: z.string().nullable().optional().describe('New start date (null to clear)'),
    priority: z
        .number()
        .min(1)
        .max(9)
        .nullable()
        .optional()
        .describe('New priority 1-9 (null to clear)'),
    categories: z.array(z.string()).optional().describe('New categories'),
    status: z
        .enum(['needs-action', 'in-process', 'completed', 'cancelled'])
        .optional()
        .describe('New status'),
    percentComplete: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Percent complete (0-100)'),
});

export async function updateTask(params: z.infer<typeof updateTaskSchema>): Promise<{
    task: Task;
    message: string;
}> {
    const client = getClient();

    const updates: TaskUpdate = {};
    if (params.summary !== undefined) updates.summary = params.summary;
    if (params.description !== undefined) updates.description = params.description ?? undefined;
    if (params.due !== undefined) updates.due = params.due;
    if (params.start !== undefined) updates.start = params.start;
    if (params.priority !== undefined) updates.priority = params.priority;
    if (params.categories !== undefined) updates.categories = params.categories;
    if (params.status !== undefined) updates.status = params.status;
    if (params.percentComplete !== undefined) updates.percentComplete = params.percentComplete;

    const task = await client.updateTask(params.taskUrl, updates);

    return {
        task,
        message: `Task updated successfully`,
    };
}

// ============================================================================
// Complete Task
// ============================================================================

export const completeTaskSchema = z.object({
    taskUrl: z.string().describe('URL of the task to mark as complete'),
});

export async function completeTask(params: z.infer<typeof completeTaskSchema>): Promise<{
    task: Task;
    message: string;
}> {
    const client = getClient();
    const task = await client.completeTask(params.taskUrl);

    return {
        task,
        message: `Task "${task.summary}" marked as complete`,
    };
}

// ============================================================================
// Delete Task
// ============================================================================

export const deleteTaskSchema = z.object({
    taskUrl: z.string().describe('URL of the task to delete'),
});

export async function deleteTask(params: z.infer<typeof deleteTaskSchema>): Promise<{
    message: string;
}> {
    const client = getClient();
    await client.deleteTask(params.taskUrl);

    return {
        message: 'Task deleted successfully',
    };
}

// ============================================================================
// List Events
// ============================================================================

export const listEventsSchema = z.object({
    calendarUrl: z.string().optional().describe('Filter to a specific calendar URL to reduce results'),
    startAfter: z.string().optional().describe('Only events starting on or after this date (ISO 8601)'),
    startBefore: z.string().optional().describe('Only events starting before this date (ISO 8601)'),
    limit: z.coerce.number().finite().optional().describe('Maximum number of events to return (lower is cheaper)'),
});

export async function listEvents(params: z.infer<typeof listEventsSchema>): Promise<{
    events: CalendarEvent[];
    count: number;
}> {
    const client = getClient();
    const events = await client.getEvents({
        calendarUrl: params.calendarUrl,
        startAfter: params.startAfter,
        startBefore: params.startBefore,
        limit: params.limit,
    });

    return {
        events,
        count: events.length,
    };
}

// ============================================================================
// Get Event
// ============================================================================

export const getEventSchema = z.object({
    eventUrl: z.string().describe('URL of the event to retrieve (use list_events first)'),
});

export async function getEvent(params: z.infer<typeof getEventSchema>): Promise<{
    event: CalendarEvent | null;
}> {
    const client = getClient();
    const event = await client.getEvent(params.eventUrl);

    return { event };
}

// ============================================================================
// Create Event
// ============================================================================

export const createEventSchema = z.object({
    calendarUrl: z
        .string()
        .optional()
        .describe('Calendar URL to create the event in. If not provided, uses the first event-capable calendar.'),
    summary: z.string().describe('Event title/summary'),
    description: z.string().optional().describe('Detailed description (keep concise if possible)'),
    location: z.string().optional().describe('Event location'),
    start: z.string().describe('Start date/time (ISO 8601 format, e.g., 2024-01-27 for all-day or 2024-01-27T18:00:00Z for specific time)'),
    end: z.string().optional().describe('End date/time (ISO 8601 format)'),
    categories: z.array(z.string()).optional().describe('Categories/tags for the event'),
    status: z.enum(['tentative', 'confirmed', 'cancelled']).optional().describe('Event status (default: confirmed)'),
    recurrenceRule: z.string().optional().describe('Recurrence rule (RRULE format, e.g., FREQ=WEEKLY;BYDAY=MO)'),
});

export async function createEvent(params: z.infer<typeof createEventSchema>): Promise<{
    event: CalendarEvent;
    message: string;
}> {
    const client = getClient();

    // Find calendar URL if not provided
    let calendarUrl = params.calendarUrl;
    if (!calendarUrl) {
        const calendars = await client.getEventCalendars();
        if (calendars.length === 0) {
            throw new Error('No calendars with event support found');
        }
        calendarUrl = calendars[0].url;
    }

    const eventData: EventCreate = {
        summary: params.summary,
        description: params.description,
        location: params.location,
        start: params.start,
        end: params.end,
        categories: params.categories,
        status: params.status,
        recurrenceRule: params.recurrenceRule,
    };

    const event = await client.createEvent(calendarUrl, eventData);

    return {
        event,
        message: `Event "${params.summary}" created successfully`,
    };
}

// ============================================================================
// Update Event
// ============================================================================

export const updateEventSchema = z.object({
    eventUrl: z.string().describe('URL of the event to update'),
    summary: z.string().optional().describe('New event title'),
    description: z.string().nullable().optional().describe('New description (null to clear; keep concise)'),
    location: z.string().nullable().optional().describe('New location (null to clear)'),
    start: z.string().optional().describe('New start date/time'),
    end: z.string().nullable().optional().describe('New end date/time (null to clear)'),
    categories: z.array(z.string()).optional().describe('New categories'),
    status: z.enum(['tentative', 'confirmed', 'cancelled']).optional().describe('New status'),
    recurrenceRule: z.string().nullable().optional().describe('New recurrence rule (null to clear)'),
});

export async function updateEvent(params: z.infer<typeof updateEventSchema>): Promise<{
    event: CalendarEvent;
    message: string;
}> {
    const client = getClient();

    const updates: EventUpdate = {};
    if (params.summary !== undefined) updates.summary = params.summary;
    if (params.description !== undefined) updates.description = params.description;
    if (params.location !== undefined) updates.location = params.location;
    if (params.start !== undefined) updates.start = params.start;
    if (params.end !== undefined) updates.end = params.end;
    if (params.categories !== undefined) updates.categories = params.categories;
    if (params.status !== undefined) updates.status = params.status;
    if (params.recurrenceRule !== undefined) updates.recurrenceRule = params.recurrenceRule;

    const event = await client.updateEvent(params.eventUrl, updates);

    return {
        event,
        message: 'Event updated successfully',
    };
}

// ============================================================================
// Delete Event
// ============================================================================

export const deleteEventSchema = z.object({
    eventUrl: z.string().describe('URL of the event to delete'),
});

export async function deleteEvent(params: z.infer<typeof deleteEventSchema>): Promise<{
    message: string;
}> {
    const client = getClient();
    await client.deleteEvent(params.eventUrl);

    return {
        message: 'Event deleted successfully',
    };
}
