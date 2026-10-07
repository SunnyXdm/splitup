import { describe, expect, it } from 'vitest';
import { createClientKeyTracker, newClientKey } from './client-key';

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
