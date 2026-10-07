import { describe, expect, it } from 'vitest';
import {
  apportionSettle,
  balanceAfterPayment,
  nettingOf,
  pairBalance,
  pairConstituents,
  remainingBalance,
  settlePrefillFor,
} from './settle';
import type { Expense, Group, SyncData } from './types';

let seq = 1;
/** `from` owes `to` the amount (groupId null = a direct expense). */
function debt(
  groupId: number | null,
  from: number,
  to: number,
  cents: number,
  currency = 'INR',
): Expense {
  return {
    id: seq++,
    groupId,
    description: 'Test',
    amountCents: cents,
    currency,
    date: '2026-09-01',
    category: 'general',
    notes: null,
    isPayment: false,
    shares: [
      { userId: to, paidCents: cents, owedCents: 0 },
      { userId: from, paidCents: 0, owedCents: cents },
    ],
    createdBy: to,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };
}

const group = (id: number, memberIds: number[]): Group => ({
  id,
  name: `Group ${id}`,
  emoji: '🧾',
  currency: 'INR',
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00Z',
  memberIds,
});

function sync(expenses: Expense[]): SyncData {
  return {
    me: { id: 1, name: 'Me', email: null, picture: null, defaultCurrency: 'INR' },
    users: [],
    friendIds: [2, 3],
    groups: [group(10, [1, 2, 3]), group(20, [1, 2])],
    expenses,
    activity: [],
    syncedAt: '',
  };
}

describe('settle sheet: prefill per person', () => {
  it('recomputes amount and direction from the NEW person, never carrying over', () => {
    // Priya (2) owes me ₹500; I owe Cara (3) ₹200 (direct).
    const s = sync([debt(10, 2, 1, 50_000), debt(null, 1, 3, 20_000)]);
    expect(settlePrefillFor(s, null, 2, 'INR')).toEqual({
      currency: 'INR',
      cents: 50_000,
      direction: 'they_paid',
    });
    expect(settlePrefillFor(s, null, 3, 'INR')).toEqual({
      currency: 'INR',
      cents: 20_000,
      direction: 'i_paid',
    });
  });

  it('clears the suggestion for someone with no balance', () => {
    const s = sync([debt(10, 2, 1, 50_000)]);
    expect(settlePrefillFor(s, null, 3, 'INR')).toEqual({
      currency: 'INR',
      cents: null,
      direction: 'i_paid',
    });
  });

  it('moves to the currency the person actually has a balance in', () => {
    const s = sync([debt(null, 3, 1, 1_000, 'USD')]);
    expect(settlePrefillFor(s, null, 3, 'INR')).toEqual({
      currency: 'USD',
      cents: 1_000,
      direction: 'they_paid',
    });
  });

  it('uses the routed edge in group mode', () => {
    const s = sync([debt(10, 3, 1, 9_000)]);
    expect(settlePrefillFor(s, 10, 3, 'INR')).toMatchObject({
      cents: 9_000,
      direction: 'they_paid',
    });
    expect(settlePrefillFor(s, 10, 2, 'INR').cents).toBeNull();
  });
});

describe('settle sheet: netting and remaining balance', () => {
  it('explains offsets as owed-to-you minus you-owe', () => {
    const s = sync([debt(10, 2, 1, 5_098_546), debt(20, 1, 2, 307_000)]);
    expect(nettingOf(pairConstituents(s, 2, 'INR'))).toEqual({
      owedToYouCents: 5_098_546,
      youOweCents: 307_000,
      netCents: 4_791_546,
    });
    expect(nettingOf(pairConstituents(sync([debt(10, 2, 1, 100)]), 2, 'INR'))).toBeNull();
  });

  it('computes the balance after a partial, full and over-payment (friend mode)', () => {
    const s = sync([debt(10, 2, 1, 5_098_546), debt(20, 1, 2, 307_000)]);
    const before = pairBalance(s, null, 2, 'INR');
    expect(before).toBe(4_791_546);
    const after = (amount: number) =>
      balanceAfterPayment(
        s,
        null,
        2,
        'INR',
        apportionSettle(pairConstituents(s, 2, 'INR'), amount, 'they_paid', 1, 2),
      );
    expect(remainingBalance(before, after(1_000_000))).toEqual({
      afterCents: 3_791_546,
      settled: false,
      reversed: false,
      overpaidCents: 0,
    });
    expect(remainingBalance(before, after(4_791_546)).settled).toBe(true);
    expect(remainingBalance(before, after(4_800_000))).toEqual({
      afterCents: -8_454,
      settled: false,
      reversed: true,
      overpaidCents: 8_454,
    });
  });

  it('computes the after-balance in group mode with the group’s own simplification', () => {
    const s = sync([debt(10, 3, 1, 9_000)]);
    const row = { groupId: 10, payerId: 3, recipientId: 1, amountCents: 4_000 };
    expect(balanceAfterPayment(s, 10, 3, 'INR', [row])).toBe(5_000);
  });
});
