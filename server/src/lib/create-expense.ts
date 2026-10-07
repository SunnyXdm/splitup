import { db, nowIso, type UserRow } from '../db';
import type { ExpenseCreateBody } from '../validate';
import {
  assertDepartedUnchanged,
  checkExpenseInput,
  expenseSummary,
  expenseWire,
  insertShares,
  paymentSummary,
  recordActivity,
} from './expense';
import { notifyExpense } from './notify-events';
import type { Expense } from './wire';

/** The expense already recorded under this creator's idempotency key, if any. */
export function expenseByClientKey(meId: number, clientKey: string): Expense | null {
  const prior = db
    .prepare<[number, string], { id: number }>(
      'SELECT id FROM expenses WHERE created_by = ? AND client_key = ?',
    )
    .get(meId, clientKey);
  return prior ? expenseWire(prior.id) : null;
}

/**
 * THE create-expense path (POST /api/expenses and recurring adds alike):
 * idempotent replay, semantic checks, insert + shares + activity in one
 * transaction, then the push notification after commit. `inTx` runs inside
 * the same transaction with the new expense, so a caller's own bookkeeping
 * (e.g. marking a recurring occurrence added) commits or rolls back with it.
 */
export function createExpense(
  me: UserRow,
  body: ExpenseCreateBody,
  inTx?: (expense: Expense) => void,
): Expense {
  // Idempotent retry: the original insert already happened → return it as-is,
  // before re-validating (membership may have changed since the first try).
  if (body.clientKey !== undefined) {
    const prior = expenseByClientKey(me.id, body.clientKey);
    if (prior) return prior;
  }
  checkExpenseInput(me, body);
  if (body.groupId !== null) {
    assertDepartedUnchanged(body.groupId, null, { currency: body.currency, shares: body.shares });
  }
  const description = body.isPayment ? 'Payment' : body.description;
  const now = nowIso();
  const expense = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
           is_payment, created_by, created_at, updated_at, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.groupId,
        description,
        body.amountCents,
        body.currency,
        body.date,
        body.category,
        body.notes || null,
        body.isPayment ? 1 : 0,
        me.id,
        now,
        now,
        body.clientKey ?? null,
      );
    const id = Number(info.lastInsertRowid);
    insertShares(id, body.shares);
    const shareUserIds = body.shares.map((s) => s.userId);
    const summary = body.isPayment
      ? paymentSummary(body.shares, body.groupId, body.currency)
      : expenseSummary('added', me, description, body.groupId, shareUserIds);
    recordActivity(me.id, body.isPayment ? 'payment_added' : 'expense_added', body.groupId, id, summary);
    const created = expenseWire(id);
    inTx?.(created);
    return created;
  })();
  notifyExpense('created', me, expense);
  return expense;
}
