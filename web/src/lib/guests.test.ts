import { describe, expect, it } from 'vitest';
import { claimShareText, guestRemovable, isGuest, normalizeGuestName } from './guests';
import { makeExpense, makeSync, user } from './test-fixtures';

const guest = { ...user(5, 'Ravi'), isGuest: true };

describe('isGuest', () => {
  it('is true only for flagged users', () => {
    expect(isGuest(guest)).toBe(true);
    expect(isGuest(user(2, 'Ben'))).toBe(false);
    expect(isGuest(undefined)).toBe(false);
  });
});

describe('normalizeGuestName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeGuestName('  Ravi   Kumar ')).toBe('Ravi Kumar');
  });

  it('rejects empty and over-long names', () => {
    expect(normalizeGuestName('   ')).toBeNull();
    expect(normalizeGuestName('x'.repeat(61))).toBeNull();
    expect(normalizeGuestName('x'.repeat(60))).toBe('x'.repeat(60));
  });
});

describe('guestRemovable', () => {
  const base = makeSync({
    users: [...makeSync().users, guest],
    groups: [{ ...makeSync().groups[0], memberIds: [1, 2, 4, 5] }],
  });

  it('allows removing a guest with no balance', () => {
    expect(guestRemovable(base, 10, 5)).toBe(true);
  });

  it('refuses while the guest has a balance', () => {
    const sync = {
      ...base,
      expenses: [
        makeExpense({
          amountCents: 1000,
          shares: [
            { userId: 1, paidCents: 1000, owedCents: 500 },
            { userId: 5, paidCents: 0, owedCents: 500 },
          ],
        }),
      ],
    };
    expect(guestRemovable(sync, 10, 5)).toBe(false);
  });
});

describe('claimShareText', () => {
  it('names the group and carries the link', () => {
    expect(claimShareText('Goa', 'https://x.test/claim/abc')).toBe(
      'Join me on Splitup to see what you owe in Goa: https://x.test/claim/abc',
    );
  });
});
