import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso } from '../db';
import { expenseBody, idParam } from '../validate';
import { readJson } from '../lib/wire';
import {
  checkExpenseInput,
  editableExpenseOr404,
  expenseSummary,
  expenseWire,
  insertShares,
  paymentSummary,
  recordActivity,
  sharesOf,
} from '../lib/expense';

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.post('/', async (c) => {
  const me = c.get('user');
  const body = expenseBody.parse(await readJson(c));
  checkExpenseInput(me, body);
  const description = body.isPayment ? 'Payment' : body.description;
  const now = nowIso();
  const expense = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
           is_payment, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return c.json(expense);
});

app.patch('/:id', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const existing = editableExpenseOr404(me, id);
  const body = expenseBody.parse(await readJson(c));
  // An edit may not move an expense between scopes or turn it into/out of a
  // payment: authorization and settled states are scoped to where it lives.
  if (body.groupId !== existing.group_id) {
    throw new HTTPException(400, { message: 'an expense cannot move between groups' });
  }
  if (body.isPayment !== (existing.is_payment === 1)) {
    throw new HTTPException(400, { message: 'an expense cannot become a payment' });
  }
  // Participants who have since left the group stay editable (grandfathered);
  // new participants must be current members.
  const grandfathered = new Set(sharesOf(id).map((s) => s.user_id));
  checkExpenseInput(me, body, grandfathered);
  const description = body.isPayment ? 'Payment' : body.description;
  const now = nowIso();
  const expense = db.transaction(() => {
    db.prepare(
      `UPDATE expenses SET group_id = ?, description = ?, amount_cents = ?, currency = ?, date = ?,
         category = ?, notes = ?, is_payment = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
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
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
    insertShares(id, body.shares);
    const shareUserIds = body.shares.map((s) => s.userId);
    const summary = body.isPayment
      ? `${me.name} updated a payment: ${paymentSummary(body.shares, body.groupId, body.currency)}`
      : expenseSummary('updated', me, description, body.groupId, shareUserIds);
    recordActivity(me.id, 'expense_updated', body.groupId, id, summary);
    return expenseWire(id);
  })();
  return c.json(expense);
});

app.delete('/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const row = editableExpenseOr404(me, id);
  const now = nowIso();
  db.transaction(() => {
    const shareUserIds = sharesOf(id).map((s) => s.user_id);
    db.prepare('UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    recordActivity(
      me.id,
      'expense_deleted',
      row.group_id,
      id,
      expenseSummary('deleted', me, row.description, row.group_id, shareUserIds),
    );
  })();
  return c.body(null, 204);
});

export default app;
