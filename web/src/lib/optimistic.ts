import type { Expense, ExpenseInput, SettlementBatch, SyncData } from './types';

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
  return {
    ...sync,
    expenses: sync.expenses.map((e) => (e.id === real.id ? real : e)),
  };
}

/** True for optimistic rows that don't exist server-side yet. */
export const isTempId = (id: number): boolean => id < 0;

/** The dataset without optimistic temp rows (and temp batches) — what is safe to persist. */
export function withoutTempRows(sync: SyncData): SyncData {
  let next = sync;
  if (sync.expenses.some((e) => isTempId(e.id))) {
    next = { ...next, expenses: sync.expenses.filter((e) => !isTempId(e.id)) };
  }
  if (sync.settlementBatches?.some((b) => isTempId(b.id))) {
    next = {
      ...next,
      settlementBatches: sync.settlementBatches.filter((b) => !isTempId(b.id)),
    };
  }
  return next;
}

/** Adds (or replaces, by id) a settle-up batch. */
export function withBatch(sync: SyncData, batch: SettlementBatch): SyncData {
  const rest = (sync.settlementBatches ?? []).filter((b) => b.id !== batch.id);
  return { ...sync, settlementBatches: [...rest, batch] };
}

/** Drops a batch only (rows untouched) — e.g. the temp batch of a failed settle. */
export function withoutBatchOnly(sync: SyncData, batchId: number): SyncData {
  if (!sync.settlementBatches?.some((b) => b.id === batchId)) return sync;
  return {
    ...sync,
    settlementBatches: sync.settlementBatches.filter((b) => b.id !== batchId),
  };
}

/**
 * Swaps the optimistic temp batch for the server's once a settle succeeds. If
 * a refetch already brought the real batch in, the temp one is just dropped.
 */
export function withResolvedBatch(sync: SyncData, tempId: number, real: SettlementBatch): SyncData {
  const batches = sync.settlementBatches ?? [];
  const hasReal = batches.some((b) => b.id === real.id);
  return {
    ...sync,
    settlementBatches: hasReal
      ? batches.filter((b) => b.id !== tempId)
      : batches.some((b) => b.id === tempId)
        ? batches.map((b) => (b.id === tempId ? real : b))
        : [...batches, real],
  };
}

/** Optimistic undo: the batch and every row recorded for it disappear together. */
export function withoutBatch(sync: SyncData, batchId: number): SyncData {
  const rows = new Set(
    (sync.settlementBatches?.find((b) => b.id === batchId)?.rows ?? []).concat(
      sync.expenses.filter((e) => e.settlementBatchId === batchId).map((e) => e.id),
    ),
  );
  return {
    ...withoutBatchOnly(sync, batchId),
    expenses: sync.expenses.filter((e) => !rows.has(e.id)),
  };
}

/**
 * Rollback of an optimistic undo: re-inserts the batch and those of its rows
 * that are still absent. If a refetch already shows them, nothing changes.
 */
export function withRestoredBatch(
  sync: SyncData,
  batch: SettlementBatch,
  rows: readonly Expense[],
): SyncData {
  let next = sync;
  for (const row of rows) next = withRestoredExpense(next, row);
  return next.settlementBatches?.some((b) => b.id === batch.id) ? next : withBatch(next, batch);
}
