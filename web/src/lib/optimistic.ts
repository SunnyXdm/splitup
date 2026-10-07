import type { Expense, ExpenseInput, SyncData } from './types';

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

export function withCreatedExpense(
  sync: SyncData,
  input: ExpenseInput,
  meId: number,
  id: number = tempExpenseId(),
): SyncData {
  const now = nowIso();
  return {
    ...sync,
    expenses: [
      ...sync.expenses,
      {
        id,
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
            // updatedAt stays the server's: it is the edit-conflict token
            // (expectedUpdatedAt) and part of the settle watermark, so a fake
            // client timestamp would only manufacture spurious 409s.
          }
        : e,
    ),
  };
}

export function withoutExpense(sync: SyncData, id: number): SyncData {
  return { ...sync, expenses: sync.expenses.filter((e) => e.id !== id) };
}

/** Drops the given (temp) rows — the rollback of an optimistic create. */
export function withoutExpenses(sync: SyncData, ids: readonly number[]): SyncData {
  if (ids.length === 0) return sync;
  const drop = new Set(ids);
  return { ...sync, expenses: sync.expenses.filter((e) => !drop.has(e.id)) };
}

/**
 * Swaps a temp row for the server's real row once a create succeeds. If a
 * refetch already brought the real row in, the temp row is just dropped (no
 * duplicate).
 */
export function withResolvedTemp(sync: SyncData, tempId: number, real: Expense): SyncData {
  const hasReal = sync.expenses.some((e) => e.id === real.id);
  return {
    ...sync,
    expenses: hasReal
      ? sync.expenses.filter((e) => e.id !== tempId)
      : sync.expenses.map((e) => (e.id === tempId ? real : e)),
  };
}

/**
 * Rollback of an optimistic update: restores `prev` only while the cached row
 * is still exactly the optimistic row this mutation wrote (object identity).
 * If a refetch or a later edit has replaced it meanwhile, that row wins.
 */
export function withRestoredUpdate(sync: SyncData, prev: Expense, optimistic: Expense): SyncData {
  return {
    ...sync,
    expenses: sync.expenses.map((e) => (e === optimistic ? prev : e)),
  };
}

/** Rollback of an optimistic delete: re-inserts the row if it is still absent. */
export function withRestoredExpense(sync: SyncData, prev: Expense): SyncData {
  if (sync.expenses.some((e) => e.id === prev.id)) return sync;
  return { ...sync, expenses: [...sync.expenses, prev] };
}

/** Replaces a row with the server's response (e.g. after a successful update). */
export function withServerExpense(sync: SyncData, real: Expense): SyncData {
  return { ...sync, expenses: sync.expenses.map((e) => (e.id === real.id ? real : e)) };
}

/** True for optimistic rows that don't exist server-side yet. */
export const isTempId = (id: number): boolean => id < 0;

/** The dataset without optimistic temp rows — what is safe to persist. */
export function withoutTempRows(sync: SyncData): SyncData {
  return sync.expenses.some((e) => isTempId(e.id))
    ? { ...sync, expenses: sync.expenses.filter((e) => !isTempId(e.id)) }
    : sync;
}
