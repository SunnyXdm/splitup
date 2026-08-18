import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso } from '../db';
import { settlementsBody } from '../validate';
import { readJson, type Expense } from '../lib/wire';
import {
  areFriends,
  expenseWire,
  insertShares,
  isMember,
  memberGroupOr404,
  paymentSummary,
  recordActivity,
} from '../lib/expense';

const app = new Hono<AppEnv>();
app.use(requireAuth);

/**
 * True when the user ever held a share in this group's expenses — the
 * membership relaxation for settling with someone who has since left (their
 * nonzero net still appears in the group ledger and must stay settleable).
 */
function hasShareHistory(groupId: number, userId: number): boolean {
  return (
    db
      .prepare<[number, number], { one: number }>(
        `SELECT 1 AS one FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ? AND s.user_id = ? AND e.deleted_at IS NULL LIMIT 1`,
      )
      .get(groupId, userId) !== undefined
  );
}

/**
 * Records the payment rows of one friend-balance settle atomically. Rows are
 * ordinary isPayment expenses — every balance view derives from the same
 * ledger, so recording each slice in its own group is what keeps group pages,
 * friend pages, and totals converging.
 */
app.post('/', async (c) => {
  const me = c.get('user');
  const body = settlementsBody.parse(await readJson(c));

  if (body.counterpartyId === me.id) {
    throw new HTTPException(400, { message: 'you cannot settle with yourself' });
  }
  if (!areFriends(me.id, body.counterpartyId)) {
    throw new HTTPException(400, { message: 'you can only settle with a friend' });
  }
  const pair = new Set([me.id, body.counterpartyId]);
  for (const row of body.rows) {
    if (!pair.has(row.payerId) || !pair.has(row.recipientId)) {
      throw new HTTPException(400, { message: 'rows must be between you and the counterparty' });
    }
    if (row.groupId !== null) {
      const group = memberGroupOr404(row.groupId, me.id);
      if (body.currency !== group.currency) {
        throw new HTTPException(400, { message: 'group payments must use the group currency' });
      }
      if (
        !isMember(row.groupId, body.counterpartyId) &&
        !hasShareHistory(row.groupId, body.counterpartyId)
      ) {
        throw new HTTPException(400, { message: 'counterparty has no history in that group' });
      }
    }
  }

  // Freshness guard: the client's breakdown was computed against a snapshot.
  // Compare an exact fingerprint (count + max updatedAt) over the SAME scope
  // the client sees — visible expenses of my live groups where the
  // counterparty is a member or holds a share, plus our direct expenses. A
  // deletion leaves no client-visible tombstone, but it changes the count, so
  // exact equality catches inserts, edits, and deletions alike.
  if (body.watermark !== undefined && body.watermarkCount !== undefined) {
    const { n, m } = db
      .prepare<
        [number, number, number, number, number],
        { n: number; m: string | null }
      >(
        `SELECT COUNT(*) AS n, MAX(e.updated_at) AS m FROM expenses e
         WHERE e.deleted_at IS NULL AND (
           (
             e.group_id IN (
               SELECT gm.group_id FROM group_members gm
               JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
               WHERE gm.user_id = ?
             )
             AND (
               EXISTS (
                 SELECT 1 FROM group_members gm2
                 WHERE gm2.group_id = e.group_id AND gm2.user_id = ?
               )
               OR EXISTS (
                 SELECT 1 FROM expense_shares s JOIN expenses e2 ON e2.id = s.expense_id
                 WHERE e2.group_id = e.group_id AND e2.deleted_at IS NULL AND s.user_id = ?
               )
             )
           ) OR (
             e.group_id IS NULL
             AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.user_id = ?)
             AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.user_id = ?)
           )
         )`,
      )
      .get(me.id, body.counterpartyId, body.counterpartyId, me.id, body.counterpartyId)!;
    if (n !== body.watermarkCount || (m ?? '') !== body.watermark) {
      throw new HTTPException(409, { message: 'stale' });
    }
  }

  const now = nowIso();
  const expenses = db.transaction(() => {
    const created: Expense[] = [];
    for (const row of body.rows) {
      const shares = [
        { userId: row.payerId, paidCents: row.amountCents, owedCents: 0 },
        { userId: row.recipientId, paidCents: 0, owedCents: row.amountCents },
      ];
      const info = db
        .prepare(
          `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
             is_payment, created_by, created_at, updated_at)
           VALUES (?, 'Payment', ?, ?, ?, 'general', NULL, 1, ?, ?, ?)`,
        )
        .run(row.groupId, row.amountCents, body.currency, body.date, me.id, now, now);
      const id = Number(info.lastInsertRowid);
      insertShares(id, shares);
      recordActivity(
        me.id,
        'payment_added',
        row.groupId,
        id,
        paymentSummary(shares, row.groupId, body.currency),
      );
      created.push(expenseWire(id));
    }
    return created;
  })();

  return c.json({ expenses });
});

export default app;
