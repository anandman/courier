import { describe, expect, it } from 'vitest';

import { ALWAYS_AVAILABLE_TOOLS, TOOL_GROUPS, groupForTool } from '../src/tools/groups.js';
import { tools } from '../src/tools/index.js';

const toolNames = tools.map((tool) => tool.name);

/**
 * Groups no longer decide anything. They used to hide whole feature areas from
 * every client at once, which was the wrong granularity in both directions --
 * stopping one client from sending mail meant losing search and reading too,
 * and the setting applied to every client. Permissions are per client and per
 * tool now.
 *
 * What survives is the grouping, because it is the only way to present
 * forty-odd tools to a person without a wall of controls. These tests exist to
 * keep that presentation honest: a tool missing from every group would simply
 * never appear in the settings UI, and so could never be restricted.
 */
describe('tool groups as a display arrangement', () => {
    it('places every tool in a group or in the always-available set', () => {
        const ungrouped = toolNames.filter(
            (name) => groupForTool(name) === null && !ALWAYS_AVAILABLE_TOOLS.includes(name)
        );

        expect(ungrouped).toEqual([]);
    });

    it('names no tool the server does not have', () => {
        const known = new Set(toolNames);
        const phantom = [...TOOL_GROUPS.flatMap((group) => group.tools), ...ALWAYS_AVAILABLE_TOOLS].filter(
            (name) => !known.has(name)
        );

        expect(phantom).toEqual([]);
    });

    it('puts each tool in exactly one place', () => {
        const listed = [...TOOL_GROUPS.flatMap((group) => group.tools), ...ALWAYS_AVAILABLE_TOOLS];
        expect(listed.length).toBe(new Set(listed).size);
    });

    it('gives every group a label and a description', () => {
        for (const group of TOOL_GROUPS) {
            expect(group.label, group.id).not.toBe('');
            expect(group.description, group.id).not.toBe('');
            expect(group.tools.length, group.id).toBeGreaterThan(0);
        }
    });
});

describe('choosing between a real mailbox and a migration leftover', () => {
    /**
     * isSubscribed was going to be the signal: unsubscribed folders are hidden
     * by mail clients, so an unsubscribed mailbox looked like a leftover.
     * Measuring it against a live account killed the idea -- the Inbox itself,
     * 124,500 messages and role=inbox, is isSubscribed: false, while an empty
     * roleless "Archives" is true. A model told to prefer subscribed folders
     * would skip the Inbox.
     *
     * It is still reported, because it is free and someone may want it. It is
     * the GUIDANCE that had to be right.
     */
    it('does not tell a model to judge by subscription', async () => {
        const { tools } = await import('../src/tools/index.js');
        const description = tools.find((tool) => tool.name === 'list_mailboxes')?.description ?? '';

        expect(description).toMatch(/Do NOT use isSubscribed/);
    });

    it('points at the role, the path and the count instead', async () => {
        const { tools } = await import('../src/tools/index.js');
        const description = tools.find((tool) => tool.name === 'list_mailboxes')?.description ?? '';

        expect(description).toMatch(/PREFER the mailbox carrying the ROLE/);
        expect(description).toMatch(/totalCount/);
        expect(description).toMatch(/path/);
    });
});
