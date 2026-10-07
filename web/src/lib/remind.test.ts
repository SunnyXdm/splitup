import { afterEach, describe, expect, it, vi } from 'vitest';
import { reminderText } from './remind';

describe('reminderText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('links to the app for people who can sign in', () => {
    vi.stubGlobal('window', { location: { origin: 'https://splitup.test' } });
    expect(reminderText('Ben', '₹500', 'in "Goa"')).toContain('https://splitup.test');
  });

  it('is plain text for a guest, with no sign-in link', () => {
    const text = reminderText('Ravi', '₹500', 'in "Goa"', { withLink: false });
    expect(text).toBe('Hey Ravi! Friendly reminder — you owe me ₹500 in "Goa".');
    expect(text).not.toContain('http');
  });
});
