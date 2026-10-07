import { describe, expect, it } from 'vitest';
import {
  withCreatedExpense,
  withResolvedTemp,
  withRestoredExpense,
  withRestoredUpdate,
  withUpdatedExpense,
  withoutExpense,
  withoutExpenses,
} from './optimistic';
import type { Expense, ExpenseInput, SyncData } from './types';

const input: ExpenseInput = {
  groupId: null,
  description: 'Lunch',
  amountCents: 1000,
  currency: 'USD',
  date: '2026-01-01',
  category: 'food',
  notes: null,
  isPayment: false,
  shares: [
    { userId: 1, paidCents: 1000, owedCents: 500 },
    { userId: 2, paidCents: 0, owedCents: 500 },
  ],
};

const server = (id: number, extra: Partial<Expense> = {}): Expense => ({
  ...input,
  id,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

const base: SyncData = {
  me: { id: 1, name: 'Me', email: null, picture: null, defaultCurrency: 'USD' },
  users: [],
  friendIds: [2],
  groups: [],
  expenses: [server(1)],
  activity: [],
  syncedAt: '',
};

describe('per-mutation rollback', () => {
  it('a failed create removes only its own temp row, keeping a concurrent one', () => {
    const a = withCreatedExpense(base, input, 1, -10);
    const both = withCreatedExpense(a, input, 1, -11);
    const rolledBack = withoutExpenses(both, [-10]);
    expect(rolledBack.expenses.map((e) => e.id)).toEqual([1, -11]);
  });

  it('a successful create swaps the temp row for the server row without duplicating', () => {
    const temp = withCreatedExpense(base, input, 1, -10);
    expect(withResolvedTemp(temp, -10, server(7)).expenses.map((e) => e.id)).toEqual([1, 7]);
    const alreadyFetched = { ...temp, expenses: [...temp.expenses, server(7)] };
    expect(withResolvedTemp(alreadyFetched, -10, server(7)).expenses.map((e) => e.id)).toEqual([
      1, 7,
    ]);
  });

  it('a failed update restores the row only if it is still the optimistic version', () => {
    const prev = base.expenses[0];
    const updated = withUpdatedExpense(base, 1, { ...input, description: 'Dinner' });
    const optimistic = updated.expenses[0];
    expect(optimistic.updatedAt).toBe(prev.updatedAt); // conflict token untouched
    expect(withRestoredUpdate(updated, prev, optimistic).expenses[0]).toBe(prev);
    // A later edit (or refetch) replaced the row: the rollback leaves it alone.
    const later = withUpdatedExpense(updated, 1, { ...input, description: 'Brunch' });
    expect(withRestoredUpdate(later, prev, optimistic).expenses[0].description).toBe('Brunch');
  });

  it('a failed delete re-inserts the row once', () => {
    const prev = base.expenses[0];
    const deleted = withoutExpense(base, 1);
    expect(withRestoredExpense(deleted, prev).expenses).toEqual([prev]);
    expect(withRestoredExpense(base, prev).expenses).toHaveLength(1);
  });
});
