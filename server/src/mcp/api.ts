import { Hono } from 'hono';
import { asInternalRequest, type AppEnv } from '../auth';
import type { UserRow } from '../db';
import { errorResponse } from '../errors';
import expenseRoutes from '../routes/expenses';
import groupRoutes from '../routes/groups';
import recurringRoutes from '../routes/recurring';
import settlementRoutes from '../routes/settlements';
import syncRoutes from '../routes/sync';

/**
 * MCP tools read and write through the SAME route handlers the web app calls
 * — validation, revisions, archive auto-unarchive, departed-member guards,
 * settlement batches, activity and push notifications all come for free and
 * can't drift. Requests are dispatched in-process (no socket, no cookie): the
 * token owner is attached to the Request object (auth.ts asInternalRequest),
 * and the browser-only middleware (CSRF, cookie rate limits, static files)
 * is simply not mounted here.
 */
const api = new Hono<AppEnv>();
api.route('/api/sync', syncRoutes);
api.route('/api/groups', groupRoutes);
api.route('/api/expenses', expenseRoutes);
api.route('/api/settlements', settlementRoutes);
api.route('/api/recurring', recurringRoutes);
api.onError(errorResponse);

/** A non-2xx answer from an API route, with its JSON body. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export async function callApi<T>(
  user: UserRow,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const request = asInternalRequest(
    new Request(`http://internal${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    user,
  );
  const res = await api.fetch(request);
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiCallError(
      res.status,
      typeof data.error === 'string' ? data.error : `request failed (${res.status})`,
      data,
    );
  }
  return data as T;
}
