import { describe, expect, it } from 'vitest';
import { formatDateSafe, parseDateSafe } from './dates';

describe('safe date helpers', () => {
  it('formats valid dates', () => {
    expect(formatDateSafe('2026-03-05', 'MMM d')).toBe('Mar 5');
  });

  it('falls back instead of throwing on malformed input', () => {
    expect(formatDateSafe('2026-13-45', 'MMM d')).toBe('Unknown date');
    expect(formatDateSafe('', 'MMM d', '?')).toBe('?');
    expect(formatDateSafe(undefined, 'MMM d')).toBe('Unknown date');
    expect(parseDateSafe('garbage')).toBeNull();
  });
});
