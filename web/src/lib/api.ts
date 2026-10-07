export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, { method = 'GET', body }: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** The server's 409 when an edit started from an outdated copy of the expense. */
export const isConflict = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.message === 'conflict';

/** The server's 409 when a change would move a departed member's balance. */
export const isDepartedMember = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.message === 'departed member';

/** The settlements endpoint's 409 when balances moved since the breakdown. */
export const isStale = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.message === 'stale';

/** Human copy for a failed write: known server codes get a clear sentence. */
export function errorMessage(err: unknown): string {
  if (isConflict(err)) return 'Someone else changed this expense — reopen to see the latest.';
  if (isDepartedMember(err)) {
    return 'This would change the balance of someone who left the group.';
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong — please try again.';
}
