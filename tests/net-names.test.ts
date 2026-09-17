/**
 * Naming the machine a client runs on.
 *
 * A stored address answers "which machine" only for someone who has memorised
 * their own address plan. Reverse DNS is the portable way to turn it into a
 * name: PTR records work the same for MagicDNS, a corporate resolver, or a
 * cloud reverse zone, and a deployment with none simply keeps seeing addresses.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
});

async function withReverse(impl: (address: string) => Promise<string[]>) {
    vi.doMock('node:dns', () => ({ promises: { reverse: impl } }));
    return (await import('../src/net-names.js')).describeAddresses;
}

describe('describeAddresses', () => {
    it('maps an address to its hostname', async () => {
        const describeAddresses = await withReverse(async () => ['workstation.example.ts.net']);

        const names = await describeAddresses(['100.64.0.2']);

        expect(names.get('100.64.0.2')).toBe('workstation.example.ts.net');
    });

    it('omits an address with no PTR rather than inventing one', async () => {
        // The caller falls back to showing the address, which is still true.
        const describeAddresses = await withReverse(async () => {
            throw new Error('ENOTFOUND');
        });

        const names = await describeAddresses(['203.0.113.99']);

        expect(names.has('203.0.113.99')).toBe(false);
    });

    it('never rejects, so a resolver outage cannot cost the page', async () => {
        const describeAddresses = await withReverse(async () => {
            throw new Error('ESERVFAIL');
        });

        await expect(describeAddresses(['203.0.113.99'])).resolves.toBeInstanceOf(Map);
    });

    it('looks up each distinct address once', async () => {
        const reverse = vi.fn(async () => ['host.example']);
        const describeAddresses = await withReverse(reverse);

        await describeAddresses(['10.0.0.1', '10.0.0.1', '10.0.0.1']);

        expect(reverse).toHaveBeenCalledTimes(1);
    });

    it('ignores undefined entries, since a client may never have been seen', async () => {
        const reverse = vi.fn(async () => ['host.example']);
        const describeAddresses = await withReverse(reverse);

        const names = await describeAddresses([undefined, undefined]);

        expect(names.size).toBe(0);
        expect(reverse).not.toHaveBeenCalled();
    });

    it('gives up on a slow resolver instead of holding the render', async () => {
        const describeAddresses = await withReverse(
            () => new Promise<string[]>((resolve) => setTimeout(() => resolve(['late.example']), 5000))
        );

        const started = Date.now();
        const names = await describeAddresses(['10.0.0.1']);

        expect(names.size).toBe(0);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});
