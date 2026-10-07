import { HTTPException } from 'hono/http-exception';
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
import { participantsOf, unarchiveAffected } from './archive';
import { notifyExpense } from './notify-events';
import { resolveMergedShares } from './guests';
import { recordRevision, visibleExpenseOr404, type ExpenseSnapshot } from './revisions';
import type { Expense } from './wire';

/** 409 code: the key's original write happened, but was deleted/undone since. */
export const REMOVED_SINCE = 'already saved and later removed';
/** 409 code: the key already recorded a DIFFERENT expense (body `expenseId`). */
export const KEY_REUSED = 'key reused';

/** The id of the expense recorded under this creator's idempotency key, if any. */
export function expenseIdByClientKey(meId: number, clientKey: string): number | null {
  return (
    db
      .prepare<[number, string], { id: number }>(
        'SELECT id FROM expenses WHERE created_by = ? AND client_key = ?',
      )
      .get(meId, clientKey)?.id ?? null
  );
}

/**
 * A replayed write may only hand back what the caller can still see, and only
 * as live: 404 when the expense is no longer visible to them (left the group,
 * group deleted, no longer a share holder), 409 REMOVED_SINCE when it was
 * soft-deleted after it was recorded.
 */
export function replayedExpense(me: UserRow, id: number): Expense {
  const row = visibleExpenseOr404(me, id);
  if (row.deleted_at !== null) throw new HTTPException(409, { message: REMOVED_SINCE });
  return expenseWire(id);
}

/** The state an expense was created with (its 'created' revision), else its current one. */
function createdState(id: number): Core {
  const created = db
    .prepare<[number], { snapshot: string }>(
      `SELECT snapshot FROM expense_revisions WHERE expense_id = ? AND action = 'created'
       ORDER BY revision LIMIT 1`,
    )
    .get(id);
  return created ? (JSON.parse(created.snapshot) as ExpenseSnapshot) : expenseWire(id);
}

interface Core {
  groupId: number | null;
  amountCents: number;
  currency: string;
  date: string;
  description: string;
  isPayment: boolean;
  shares: { userId: number; paidCents: number; owedCents: number }[];
}

/** Core fields of a create, comparable across a retry (claimed guests resolved). */
function coreOf(s: Core): string {
  return JSON.stringify([
    s.groupId,
    s.amountCents,
    s.currency,
    s.date,
    s.isPayment ? 'Payment' : s.description,
    s.isPayment,
    resolveMergedShares(s.shares.map((x) => ({ ...x })))
      .sort((a, b) => a.userId - b.userId)
      .map((x) => [x.userId, x.paidCents, x.owedCents]),
  ]);
}

/**
 * A retry must carry the payload its key was first used with. A different
 * one (e.g. a draft edited after an ambiguous save) is not a retry: 409
 * KEY_REUSED with the id of what the key already recorded, never a silent
 * replay of the old expense.
 */
export function assertSamePayload(id: number, body: ExpenseCreateBody): void {
  if (coreOf(createdState(id)) !== coreOf(body)) {
    throw new HTTPException(409, { message: KEY_REUSED, cause: { expenseId: id } });
  }
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
  // before re-validating — but only if the caller can still see it, it is
  // still live, and the payload is the one the key was first used with.
  if (body.clientKey !== undefined) {
    const priorId = expenseIdByClientKey(me.id, body.clientKey);
    if (priorId !== null) {
      const prior = replayedExpense(me, priorId);
      assertSamePayload(priorId, body);
      return prior;
    }
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
    recordRevision(id, 'created', me.id, now);
    if (body.groupId !== null) unarchiveAffected(body.groupId, participantsOf(body.shares));
    const created = expenseWire(id);
    inTx?.(created);
    return created;
  })();
  notifyExpense('created', me, expense);
  return expense;
}
