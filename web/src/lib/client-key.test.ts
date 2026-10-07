import { describe, expect, it } from 'vitest';
import { ApiError, isAmbiguousFailure, isKeyReused, isRemovedSince, reusedExpenseId } from './api';
import { createClientKeyTracker, createRetryMemo, newClientKey } from './client-key';

describe('client keys', () => {
  it('match the server format', () => {
    for (let i = 0; i < 20; i++) expect(newClientKey()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('reuse the key for an identical retry and rotate on any change', () => {
    const keyFor = createClientKeyTracker();
    const a = keyFor({ amount: 100 });
    expect(keyFor({ amount: 100 })).toBe(a);
    const b = keyFor({ amount: 200 });
    expect(b).not.toBe(a);
    expect(keyFor({ amount: 100 })).not.toBe(a);
  });
});

describe('retry memo', () => {
  it('resends the exact kept request while the visible inputs are unchanged', () => {
    const memo = createRetryMemo<{ watermark: string; clientKey: string }>();
    const first = memo.request({ amount: 500 }, (clientKey) => ({ watermark: 'w1', clientKey }));
    // A refetch moved the watermark — it is derived, so the retry keeps the old body.
    const retry = memo.request({ amount: 500 }, (clientKey) => ({ watermark: 'w2', clientKey }));
    expect(retry).toBe(first);
    expect(retry.watermark).toBe('w1');
  });

  it('builds a fresh request with a new key once an input changes, or after reset', () => {
    const memo = createRetryMemo<{ clientKey: string }>();
    const build = (clientKey: string) => ({ clientKey });
    const a = memo.request({ amount: 500 }, build);
    const b = memo.request({ amount: 600 }, build);
    expect(b.clientKey).not.toBe(a.clientKey);
    memo.reset();
    const c = memo.request({ amount: 600 }, build);
    expect(c.clientKey).not.toBe(b.clientKey);
  });
});

describe('write failure kinds', () => {
  it('treats network errors and 5xx as ambiguous, 4xx as definite', () => {
    expect(isAmbiguousFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAmbiguousFailure(new ApiError(502, 'Request failed (502)'))).toBe(true);
    expect(isAmbiguousFailure(new ApiError(409, 'stale'))).toBe(false);
    expect(isAmbiguousFailure(new ApiError(400, 'bad'))).toBe(false);
  });

  it('reads the reused-key expense id and the removed-since code', () => {
    const reused = new ApiError(409, 'key reused', { error: 'key reused', expenseId: 42 });
    expect(isKeyReused(reused)).toBe(true);
    expect(reusedExpenseId(reused)).toBe(42);
    expect(reusedExpenseId(new ApiError(409, 'conflict'))).toBeNull();
    expect(isRemovedSince(new ApiError(409, 'already saved and later removed'))).toBe(true);
  });
});
