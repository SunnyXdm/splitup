import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The app a write came through (an MCP client's name), for the duration of
 * one MCP tool call. recordActivity appends it to the activity summary, so
 * the feed shows "Sunny added 'Dinner' in Goa (via Claude)".
 */
const via = new AsyncLocalStorage<string>();

export const runVia = <T>(name: string, fn: () => T): T => via.run(name, fn);
export const currentVia = (): string | undefined => via.getStore();
