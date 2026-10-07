import type { ReceiptScanResult } from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(
  path: string,
  { method = 'GET', body, signal }: ApiOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    signal,
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
  if (err instanceof ApiError && err.status === 409 && err.message === 'group deleted') {
    return 'One of the groups this was recorded in has been deleted.';
  }
  if (err instanceof ApiError && err.status === 409 && err.message === 'part of a settle-up') {
    return 'This payment is part of a settle-up — open it and use Undo payment instead.';
  }
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong — please try again.';
}

/** Send a (downscaled) receipt photo for extraction into a draft expense. */
export function scanReceipt(image: string, signal?: AbortSignal): Promise<ReceiptScanResult> {
  return api<ReceiptScanResult>('/api/receipts/scan', { method: 'POST', body: { image }, signal });
}

/** Friendly copy for a failed receipt scan. */
export function scanErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return err.message === 'busy'
        ? 'The scanner is busy — try again in a moment.'
        : "You've hit the receipt-scan limit for now — try again later.";
    }
    if (err.status === 503) return 'Receipt scanning is unavailable right now.';
    if (err.status === 504) return 'Reading the receipt took too long — try a clearer photo.';
    if (err.status === 413) return 'That photo is too large — try another one.';
    if (err.status === 400) return "That image couldn't be used — try another photo.";
    if (err.status === 401) return 'Sign in again to scan receipts.';
    return "Couldn't read that receipt — try another photo or enter it by hand.";
  }
  return 'Scanning failed — check your connection and try again.';
}
