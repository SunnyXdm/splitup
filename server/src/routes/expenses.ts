import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type ExpenseRow, type ShareRow } from '../db';
import { createExpense } from '../lib/create-expense';
import {
  deletedExpensesQuery,
  expenseCreateBody,
  expensePatchBody,
  expenseRestoreBody,
  expenseSnapshotSchema,
  idParam,
} from '../validate';
import { readJson, toExpense, type Category, type Expense } from '../lib/wire';
import { notifyExpense } from '../lib/notify-events';
import { resolveMergedShares } from '../lib/guests';
import { participantsOf, unarchiveAffected } from '../lib/archive';
import {
  recordRevision,
  revisionOf,
  revisionsOf,
  sameSnapshot,
  usersByIds,
  visibleExpenseOr404,
  type ExpenseSnapshot,
} from '../lib/revisions';
import {
  areFriends,
  assertDepartedUnchanged,
  checkExpenseInput,
  editableExpenseOr404,
  expenseSummary,
  expenseWire,
  groupMemberIds,
  insertShares,
  memberGroupOr404,
  paymentSummary,
  recordActivity,
  shareLike,
  sharesOf,
} from '../lib/expense';

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.post('/', async (c) => {
  const me = c.get('user');
  const body = expenseCreateBody.parse(await readJson(c));
  return c.json(createExpense(me, body));
});

app.patch('/:id', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const body = expensePatchBody.parse(await readJson(c));
  // Loaded after the body await so every check below and the write run in one
  // synchronous stretch — nothing can change the row in between.
  const existing = editableExpenseOr404(me, id);
  if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== existing.updated_at) {
    throw new HTTPException(409, { message: 'conflict' });
  }
  // An edit may not move an expense between scopes or turn it into/out of a
  // payment: authorization and settled states are scoped to where it lives.
  if (body.groupId !== existing.group_id) {
    throw new HTTPException(400, { message: 'an expense cannot move between groups' });
  }
  if (body.isPayment !== (existing.is_payment === 1)) {
    throw new HTTPException(400, { message: 'an expense cannot become a payment' });
  }
  const oldShares = sharesOf(id);
  if (existing.group_id === null) {
    // A 1:1 expense stays between the same two people; swapping the other
    // party would move a debt into a pair that never agreed to it.
    const oldIds = new Set(oldShares.map((s) => s.user_id));
    if (!body.shares.every((s) => oldIds.has(s.userId))) {
      throw new HTTPException(400, { message: 'a non-group expense must keep its two people' });
    }
  }
  // Participants who have since left the group stay editable (grandfathered);
  // new participants must be current members.
  const grandfathered = new Set(oldShares.map((s) => s.user_id));
  checkExpenseInput(me, body, grandfathered);
  if (existing.group_id !== null) {
    assertDepartedUnchanged(
      existing.group_id,
      { currency: existing.currency, shares: oldShares.map(shareLike) },
      { currency: body.currency, shares: body.shares },
      true,
    );
  }
  const description = body.isPayment ? 'Payment' : body.description;
  const now = nowIso();
  const expense = db.transaction(() => {
    const { changes } = db
      .prepare(
        `UPDATE expenses SET group_id = ?, description = ?, amount_cents = ?, currency = ?, date = ?,
           category = ?, notes = ?, is_payment = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
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
        now,
        id,
      );
    if (changes === 0) throw new HTTPException(404, { message: 'not found' });
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
    insertShares(id, body.shares);
    const shareUserIds = body.shares.map((s) => s.userId);
    const summary = body.isPayment
      ? `${me.name} updated a payment: ${paymentSummary(body.shares, body.groupId, body.currency)}`
      : expenseSummary('updated', me, description, body.groupId, shareUserIds);
    recordActivity(me.id, 'expense_updated', body.groupId, id, summary);
    recordRevision(id, 'updated', me.id, now);
    if (body.groupId !== null) unarchiveAffected(body.groupId, participantsOf(body.shares));
    return expenseWire(id);
  })();
  notifyExpense(
    'edited',
    me,
    expense,
    oldShares.map((s) => s.user_id),
  );
  return c.json(expense);
});

app.delete('/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const row = editableExpenseOr404(me, id);
  const shares = sharesOf(id);
  if (row.group_id !== null) {
    assertDepartedUnchanged(
      row.group_id,
      { currency: row.currency, shares: shares.map(shareLike) },
      null,
    );
  }
  const now = nowIso();
  db.transaction(() => {
    const { changes } = db
      .prepare('UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, now, id);
    if (changes === 0) throw new HTTPException(404, { message: 'not found' });
    recordActivity(
      me.id,
      'expense_deleted',
      row.group_id,
      id,
      expenseSummary(
        'deleted',
        me,
        row.description,
        row.group_id,
        shares.map((s) => s.user_id),
      ),
    );
    recordRevision(id, 'deleted', me.id, now);
    // A deletion adds no participant, but can reopen someone's balance.
    if (row.group_id !== null) unarchiveAffected(row.group_id, []);
  })();
  notifyExpense('deleted', me, {
    id,
    groupId: row.group_id,
    description: row.description,
    currency: row.currency,
    isPayment: row.is_payment === 1,
    shares: shares.map(shareLike),
  });
  return c.body(null, 204);
});

const DELETED_WINDOW_DAYS = 90;

/** A deleted expense in the "Recently deleted" list. */
export interface DeletedExpense extends Expense {
  deletedAt: string;
  /** Who deleted it (from its history); null when unknown. */
  deletedBy: number | null;
  /** Its latest revision — what POST /:id/restore brings back. */
  revision: number;
}

/**
 * Expenses deleted in the last 90 days that I could see while live: my live
 * groups' rows, and non-group rows I hold a share in. Scoped to one group
 * (404 unless I'm a member) or to rows shared with one friend. Settle-up rows
 * are left out — they come back only through their batch.
 */
app.get('/deleted', (c) => {
  const me = c.get('user');
  const q = deletedExpensesQuery.parse(c.req.query());
  if (q.groupId !== undefined) memberGroupOr404(q.groupId, me.id);
  const since = new Date(Date.now() - DELETED_WINDOW_DAYS * 86_400_000).toISOString();
  const groupId = q.groupId ?? null;
  const friendId = q.friendId ?? null;
  const rows = db
    .prepare<unknown[], ExpenseRow>(
      `SELECT e.* FROM expenses e
       WHERE e.deleted_at IS NOT NULL AND e.deleted_at >= ? AND e.settlement_batch_id IS NULL
         AND (
           e.group_id IN (
             SELECT gm.group_id FROM group_members gm
             JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
             WHERE gm.user_id = ?
           )
           OR (e.group_id IS NULL AND EXISTS (
             SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.user_id = ?
           ))
         )
         AND (? IS NULL OR e.group_id = ?)
         AND (? IS NULL OR (
           EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.user_id = ?)
           AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.user_id = ?)
         ))
       ORDER BY e.deleted_at DESC, e.id DESC
       LIMIT 200`,
    )
    .all(since, me.id, me.id, groupId, groupId, friendId, me.id, friendId);
  const latest = db.prepare<[number], { revision: number; action: string; actor_id: number }>(
    `SELECT revision, action, actor_id FROM expense_revisions WHERE expense_id = ?
     ORDER BY revision DESC LIMIT 1`,
  );
  const userIds = new Set<number>();
  const expenses: DeletedExpense[] = rows.map((r) => {
    const shares = sharesOf(r.id);
    const last = latest.get(r.id);
    const deletedBy = last?.action === 'deleted' ? last.actor_id : null;
    for (const s of shares) userIds.add(s.user_id);
    if (deletedBy !== null) userIds.add(deletedBy);
    return {
      ...toExpense(r, shares),
      deletedAt: r.deleted_at!,
      deletedBy,
      revision: last?.revision ?? 0,
    };
  });
  return c.json({ expenses, users: usersByIds(userIds) });
});

/**
 * Revision history, newest first, for anyone who can see the expense (live or
 * deleted). `users` names every actor and share holder the history mentions —
 * some may no longer be in the caller's sync data.
 */
app.get('/:id/revisions', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  visibleExpenseOr404(me, id);
  const revisions = revisionsOf(id);
  const userIds = new Set<number>();
  for (const r of revisions) {
    userIds.add(r.actorId);
    for (const s of r.snapshot.shares) userIds.add(s.userId);
  }
  return c.json({ revisions, users: usersByIds(userIds) });
});

const restoreConflict = (message: string) => new HTTPException(409, { message });

const snapshotOfRow = (row: ExpenseRow, shares: ShareRow[]): ExpenseSnapshot => ({
  description: row.description,
  amountCents: row.amount_cents,
  currency: row.currency,
  date: row.date,
  category: row.category as Category,
  notes: row.notes,
  groupId: row.group_id,
  isPayment: row.is_payment === 1,
  shares: shares.map(shareLike),
});

/**
 * Restores an expense to one of its revisions: undeletes a deleted expense
 * and/or reverts its fields and split, recorded as a new 'restored' revision.
 * Held to every rule an edit (or, for an undelete, a create) must pass.
 */
app.post('/:id/restore', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const body = expenseRestoreBody.parse(await readJson(c));
  // Loaded after the body await so the checks and the write run in one
  // synchronous stretch.
  const existing = visibleExpenseOr404(me, id);
  if (existing.settlement_batch_id != null) {
    throw restoreConflict('part of a settle-up');
  }
  if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== existing.updated_at) {
    throw restoreConflict('conflict');
  }
  const target = revisionOf(id, body.revision);
  if (!target) throw new HTTPException(404, { message: 'revision not found' });
  const parsed = expenseSnapshotSchema.safeParse(target.snapshot);
  if (
    !parsed.success ||
    parsed.data.groupId !== existing.group_id ||
    parsed.data.isPayment !== (existing.is_payment === 1)
  ) {
    throw restoreConflict('version cannot be restored');
  }
  // Old versions may name a guest who has since been claimed: restore them
  // as the account that took the guest's shares over.
  const snap = { ...parsed.data, shares: resolveMergedShares(parsed.data.shares) };
  const wasDeleted = existing.deleted_at !== null;
  const oldShares = sharesOf(id);
  if (!wasDeleted && sameSnapshot(snap, snapshotOfRow(existing, oldShares))) {
    throw restoreConflict('already current');
  }

  const current = new Set(oldShares.map((s) => s.user_id));
  if (existing.group_id !== null) {
    const group = memberGroupOr404(existing.group_id, me.id);
    if (snap.currency !== group.currency) throw restoreConflict('group currency changed');
    // As for edits: people still on the expense are grandfathered, anyone
    // else the old version names must be a current member.
    const members = new Set(groupMemberIds(group.id));
    if (snap.shares.some((s) => !members.has(s.userId) && !current.has(s.userId))) {
      throw restoreConflict('member left');
    }
    assertDepartedUnchanged(
      existing.group_id,
      wasDeleted ? null : { currency: existing.currency, shares: oldShares.map(shareLike) },
      { currency: snap.currency, shares: snap.shares },
      !wasDeleted,
    );
  } else {
    // A 1:1 expense stays between the same two people, who must still be friends.
    const samePeople =
      snap.shares.length === current.size && snap.shares.every((s) => current.has(s.userId));
    if (!samePeople) {
      throw restoreConflict('version cannot be restored');
    }
    const other = snap.shares.find((s) => s.userId !== me.id);
    if (!other || !areFriends(me.id, other.userId)) throw restoreConflict('not friends');
  }

  const description = snap.isPayment ? 'Payment' : snap.description;
  const now = nowIso();
  const expense = db.transaction(() => {
    const { changes } = db
      .prepare(
        `UPDATE expenses SET description = ?, amount_cents = ?, currency = ?, date = ?,
           category = ?, notes = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      .run(
        description,
        snap.amountCents,
        snap.currency,
        snap.date,
        snap.category,
        snap.notes || null,
        now,
        id,
        existing.updated_at,
      );
    if (changes === 0) throw restoreConflict('conflict');
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
    insertShares(id, snap.shares);
    const summary = snap.isPayment
      ? `${me.name} restored a payment: ${paymentSummary(
          snap.shares,
          snap.groupId,
          snap.currency,
        )}`
      : expenseSummary(
          'restored',
          me,
          description,
          snap.groupId,
          snap.shares.map((s) => s.userId),
        );
    recordActivity(me.id, 'expense_restored', snap.groupId, id, summary);
    recordRevision(id, 'restored', me.id, now);
    // A restore is a write like any other: bring the group back for whoever it touches.
    if (snap.groupId !== null) {
      unarchiveAffected(
        snap.groupId,
        participantsOf(snap.shares),
      );
    }
    return expenseWire(id);
  })();
  notifyExpense(
    'restored',
    me,
    expense,
    wasDeleted ? [] : oldShares.map((s) => s.user_id),
  );
  return c.json(expense);
});

export default app;
