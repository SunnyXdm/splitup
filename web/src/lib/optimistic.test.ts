import { describe, expect, it } from 'vitest';
import {
  withBatch,
  withCreatedExpense,
  withResolvedBatch,
  withResolvedTemp,
  withRestoredBatch,
  withRestoredExpense,
  withRestoredUpdate,
  withUpdatedExpense,
  withoutBatch,
  withoutBatchOnly,
  withoutExpense,
  withoutExpenses,
  withoutTempRows,
} from './optimistic';
import type { Expense, ExpenseInput, SettlementBatch, SyncData } from './types';

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

describe('settle-up batches', () => {
  const batch = (id: number, rows: number[]): SettlementBatch => ({
    id,
    payerId: 1,
    payeeId: 2,
    amountCents: 1500,
    currency: 'USD',
    date: '2026-01-02',
    method: null,
    reference: null,
    note: null,
    createdBy: 1,
    createdAt: '2026-01-02T00:00:00Z',
    rows,
  });
  const withRows: SyncData = {
    ...base,
    expenses: [
      server(1),
      server(5, { isPayment: true, settlementBatchId: 9 }),
      server(6, { isPayment: true, settlementBatchId: 9 }),
    ],
    settlementBatches: [batch(9, [5, 6])],
  };

  it('undo removes the batch and all of its rows; rollback restores them', () => {
    const undone = withoutBatch(withRows, 9);
    expect(undone.expenses.map((e) => e.id)).toEqual([1]);
    expect(undone.settlementBatches).toEqual([]);
    const restored = withRestoredBatch(undone, batch(9, [5, 6]), withRows.expenses.slice(1));
    expect(restored.expenses.map((e) => e.id).sort()).toEqual([1, 5, 6]);
    expect(restored.settlementBatches?.map((b) => b.id)).toEqual([9]);
    // A refetch already put them back: nothing changes.
    expect(withRestoredBatch(restored, batch(9, [5, 6]), withRows.expenses.slice(1))).toEqual(
      restored,
    );
  });

  it('resolves a temp batch to the server batch without duplicates', () => {
    const temp = withBatch(base, batch(-3, [-1]));
    const ids = (s: SyncData) => s.settlementBatches?.map((b) => b.id);
    expect(ids(withResolvedBatch(temp, -3, batch(9, [5])))).toEqual([9]);
    expect(ids(withResolvedBatch(withBatch(temp, batch(9, [5])), -3, batch(9, [5])))).toEqual([9]);
    expect(withoutBatchOnly(temp, -3).settlementBatches).toEqual([]);
    expect(withoutTempRows(temp).settlementBatches).toEqual([]);
  });
});
