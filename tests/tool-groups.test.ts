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
