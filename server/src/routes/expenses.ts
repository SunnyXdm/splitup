import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso } from '../db';
import { expenseCreateBody, expensePatchBody, idParam } from '../validate';
import { readJson } from '../lib/wire';
import { notifyExpense } from '../lib/notify-events';
import {
  assertDepartedUnchanged,
  checkExpenseInput,
  editableExpenseOr404,
  expenseSummary,
  expenseWire,
  insertShares,
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
  // Idempotent retry: the original insert already happened → return it as-is,
  // before re-validating (membership may have changed since the first try).
  if (body.clientKey !== undefined) {
    const prior = db
      .prepare<[number, string], { id: number }>(
        'SELECT id FROM expenses WHERE created_by = ? AND client_key = ?',
      )
      .get(me.id, body.clientKey);
    if (prior) return c.json(expenseWire(prior.id));
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
    return expenseWire(id);
  })();
  notifyExpense('created', me, expense);
  return c.json(expense);
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

export default app;
