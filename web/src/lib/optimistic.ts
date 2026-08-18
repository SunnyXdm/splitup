import type { ExpenseInput, SyncData } from './types';

/**
 * Pure cache transforms for optimistic mutations. Temp expenses get negative
 * ids so they can never collide with server ids; the background re-sync
 * replaces them with the real rows.
 */

const nowIso = () => new Date().toISOString();

let tempSeq = 0;

export function tempExpenseId(): number {
  // ms-timestamp × 1000 + a monotonic counter: unique within a session even
  // for same-millisecond bursts, and reload-safe via the time component.
  tempSeq = (tempSeq + 1) % 1000;
  return -(Math.floor(Date.now() % 1_000_000_000) * 1000 + tempSeq);
}

export function withCreatedExpense(sync: SyncData, input: ExpenseInput, meId: number): SyncData {
  const now = nowIso();
  return {
    ...sync,
    expenses: [
      ...sync.expenses,
      {
        id: tempExpenseId(),
        groupId: input.groupId,
        description: input.isPayment ? 'Payment' : input.description,
        amountCents: input.amountCents,
        currency: input.currency,
        date: input.date,
        category: input.category,
        notes: input.notes,
        isPayment: input.isPayment,
        shares: input.shares,
        createdBy: meId,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

export function withUpdatedExpense(sync: SyncData, id: number, input: ExpenseInput): SyncData {
  return {
    ...sync,
    expenses: sync.expenses.map((e) =>
      e.id === id
        ? {
            ...e,
            groupId: input.groupId,
            description: input.isPayment ? 'Payment' : input.description,
            amountCents: input.amountCents,
            currency: input.currency,
            date: input.date,
            category: input.category,
            notes: input.notes,
            isPayment: input.isPayment,
            shares: input.shares,
            updatedAt: nowIso(),
          }
        : e,
    ),
  };
}

export function withoutExpense(sync: SyncData, id: number): SyncData {
  return { ...sync, expenses: sync.expenses.filter((e) => e.id !== id) };
}
