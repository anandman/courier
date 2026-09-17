import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { AccountManager } from './account-manager.js';

export interface RequestContext {
    accountManager?: AccountManager;
    authInfo?: AuthInfo;
    userId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
    return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
    return requestContextStorage.getStore();
}

/**
 * The network address the current request came from.
 *
 * Kept in its own store rather than on RequestContext because it must be
 * readable from `verifyAccessToken`, which the bearer-auth middleware calls
 * *before* the MCP handler establishes the main context.
 *
 * Recorded so the settings UI can answer "which client, on which machine" --
 * five permanent clients named "Claude Code" or "Codex" say nothing about where
 * they run, and this deployment has clients on at least three machines.
 */
const peerAddressStorage = new AsyncLocalStorage<string>();

export function runWithPeerAddress<T>(address: string | undefined, fn: () => T): T {
    return address ? peerAddressStorage.run(address, fn) : fn();
}

export function getPeerAddress(): string | undefined {
    return peerAddressStorage.getStore();
}
