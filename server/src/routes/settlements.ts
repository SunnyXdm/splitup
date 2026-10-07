import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type ExpenseRow, type SettlementBatchRow } from '../db';
import { idParam, settlementsBody } from '../validate';
import {
  readJson,
  toSettlementBatch,
  type Expense,
  type SettlementBatch,
} from '../lib/wire';
import { notifySettlement, notifySettlementUndone } from '../lib/notify-events';
import { unarchiveAffected } from '../lib/archive';
import { recordRevision } from '../lib/revisions';
import {
  areFriends,
  assertDepartedUnchanged,
  expenseWire,
  formatPaymentAmount,
  groupNet,
  insertShares,
  isMember,
  memberGroupOr404,
  paymentSummary,
  recordActivity,
  shareLike,
  sharesOf,
  userName,
} from '../lib/expense';

const NOT_FOUND = () => new HTTPException(404, { message: 'not found' });

/** Live payment rows of a batch, in id order. */
function batchRows(batchId: number): ExpenseRow[] {
  return db
    .prepare<[number], ExpenseRow>(
      'SELECT * FROM expenses WHERE settlement_batch_id = ? AND deleted_at IS NULL ORDER BY id',
    )
    .all(batchId);
}

export function settlementBatchWire(batchId: number): SettlementBatch | null {
  const row = db
    .prepare<[number], SettlementBatchRow>('SELECT * FROM settlement_batches WHERE id = ?')
    .get(batchId);
  if (!row) return null;
  return toSettlementBatch(
    row,
    batchRows(batchId).map((r) => r.id),
  );
}

/**
 * The cash that actually changed hands for a set of rows between `a` and `b`:
 * row directions net out (counter rows offset), leaving one payer → payee.
 */
export function netCash(
  rows: { payerId: number; recipientId: number; amountCents: number }[],
  a: number,
  b: number,
): { payerId: number; payeeId: number; amountCents: number } {
  let aToB = 0;
  for (const r of rows) aToB += r.payerId === a ? r.amountCents : -r.amountCents;
  return aToB >= 0
    ? { payerId: a, payeeId: b, amountCents: aToB }
    : { payerId: b, payeeId: a, amountCents: -aToB };
}

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

  // Idempotent retry: row 0 carries the key, row i>0 carries `key:i` (':' is
  // outside the key alphabet, so no collisions). Replay → original rows.
  if (body.clientKey !== undefined) {
    const prior = db
      .prepare<[number, string, number, string], { id: number }>(
        `SELECT id FROM expenses WHERE created_by = ?
           AND (client_key = ? OR substr(client_key, 1, ?) = ?) ORDER BY id`,
      )
      .all(me.id, body.clientKey, body.clientKey.length + 1, `${body.clientKey}:`);
    if (prior.length > 0) {
      const batchId = db
        .prepare<[number], { settlement_batch_id: number | null }>(
          'SELECT settlement_batch_id FROM expenses WHERE id = ?',
        )
        .get(prior[0].id)?.settlement_batch_id;
      return c.json({
        expenses: prior.map((r) => expenseWire(r.id)),
        batch: batchId == null ? null : settlementBatchWire(batchId),
      });
    }
  }

  if (body.counterpartyId === me.id) {
    throw new HTTPException(400, { message: 'you cannot settle with yourself' });
  }
  if (!areFriends(me.id, body.counterpartyId)) {
    throw new HTTPException(400, { message: 'you can only settle with a friend' });
  }
  const pair = new Set([me.id, body.counterpartyId]);
  const cash = netCash(body.rows, me.id, body.counterpartyId);
  if (cash.amountCents === 0) {
    throw new HTTPException(400, { message: 'payment rows cancel out' });
  }
  // Running group net of a departed counterparty, per group, as rows apply.
  const departedNet = new Map<number, number>();
  for (const row of body.rows) {
    if (!pair.has(row.payerId) || !pair.has(row.recipientId)) {
      throw new HTTPException(400, { message: 'rows must be between you and the counterparty' });
    }
    if (row.groupId !== null) {
      const group = memberGroupOr404(row.groupId, me.id);
      if (body.currency !== group.currency) {
        throw new HTTPException(400, { message: 'group payments must use the group currency' });
      }
      if (!isMember(row.groupId, body.counterpartyId)) {
        if (!hasShareHistory(row.groupId, body.counterpartyId)) {
          throw new HTTPException(400, { message: 'counterparty has no history in that group' });
        }
        // A departed member can only be settled toward zero, never past it —
        // they can't see the group to notice (or dispute) a new debt.
        const net =
          departedNet.get(row.groupId) ??
          groupNet(row.groupId, body.counterpartyId, body.currency);
        const next =
          net + (row.payerId === body.counterpartyId ? row.amountCents : -row.amountCents);
        if (net === 0 || Math.sign(next) === -Math.sign(net) || Math.abs(next) >= Math.abs(net)) {
          throw new HTTPException(409, { message: 'departed member' });
        }
        departedNet.set(row.groupId, next);
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
  const { expenses, batchId } = db.transaction(() => {
    const batchId = Number(
      db
        .prepare(
          `INSERT INTO settlement_batches (created_by, payer_id, payee_id, amount_cents, currency,
             date, method, reference, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          me.id,
          cash.payerId,
          cash.payeeId,
          cash.amountCents,
          body.currency,
          body.date,
          body.method ?? null,
          body.reference ?? null,
          body.note ?? null,
          now,
        ).lastInsertRowid,
    );
    const created: Expense[] = [];
    for (const [i, row] of body.rows.entries()) {
      const shares = [
        { userId: row.payerId, paidCents: row.amountCents, owedCents: 0 },
        { userId: row.recipientId, paidCents: 0, owedCents: row.amountCents },
      ];
      const info = db
        .prepare(
          `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
             is_payment, created_by, created_at, updated_at, client_key, settlement_batch_id)
           VALUES (?, 'Payment', ?, ?, ?, 'general', NULL, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.groupId,
          row.amountCents,
          body.currency,
          body.date,
          me.id,
          now,
          now,
          body.clientKey === undefined ? null : i === 0 ? body.clientKey : `${body.clientKey}:${i}`,
          batchId,
        );
      const id = Number(info.lastInsertRowid);
      insertShares(id, shares);
      recordActivity(
        me.id,
        'payment_added',
        row.groupId,
        id,
        paymentSummary(shares, row.groupId, body.currency),
      );
      recordRevision(id, 'created', me.id, now);
      created.push(expenseWire(id));
    }
    // Both people the cash moved between see the settle-up again.
    const groups = new Set(body.rows.flatMap((r) => (r.groupId === null ? [] : [r.groupId])));
    for (const gid of groups) unarchiveAffected(gid, pair);
    return { expenses: created, batchId };
  })();

  notifySettlement(me, body.counterpartyId, body.rows, body.currency);
  return c.json({ expenses, batch: settlementBatchWire(batchId) });
});

/**
 * Undo a whole settle-up: every live row of the batch and the batch itself
 * are soft-deleted together, or nothing is. Only the two people the cash
 * moved between (or its creator) may undo; anyone else gets a 404.
 */
app.delete('/:batchId', (c) => {
  const me = c.get('user');
  const batchId = idParam.parse(c.req.param('batchId'));
  const batch = db
    .prepare<[number], SettlementBatchRow>(
      'SELECT * FROM settlement_batches WHERE id = ? AND deleted_at IS NULL',
    )
    .get(batchId);
  if (!batch || ![batch.payer_id, batch.payee_id, batch.created_by].includes(me.id)) {
    throw NOT_FOUND();
  }

  const rows = batchRows(batchId);
  const groupIds = new Set<number>();
  for (const row of rows) {
    if (row.group_id === null) continue;
    groupIds.add(row.group_id);
    const group = db
      .prepare<[number], { deleted_at: string | null }>('SELECT deleted_at FROM groups WHERE id = ?')
      .get(row.group_id);
    // A deleted group's ledger is frozen — undoing would rewrite it.
    if (!group || group.deleted_at !== null) {
      throw new HTTPException(409, { message: 'group deleted' });
    }
    // Nobody may move a departed member's group net (they can't see it).
    assertDepartedUnchanged(
      row.group_id,
      { currency: row.currency, shares: sharesOf(row.id).map(shareLike) },
      null,
    );
  }

  const now = nowIso();
  const counterpart = batch.payer_id === me.id ? batch.payee_id : batch.payer_id;
  db.transaction(() => {
    const { changes } = db
      .prepare('UPDATE settlement_batches SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, batchId);
    if (changes === 0) throw NOT_FOUND();
    const del = db.prepare(
      'UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    for (const row of rows) {
      del.run(now, now, row.id);
      recordRevision(row.id, 'deleted', me.id, now);
    }
    // Undoing reopens debts: whoever is unsettled again gets the group back.
    for (const gid of groupIds) unarchiveAffected(gid, []);
    const amount = formatPaymentAmount(batch.amount_cents, batch.currency);
    // A settle recorded entirely inside one group stays in that group's feed;
    // anything else is tied to a row both people hold a share in, so both see it.
    const soleGroup =
      groupIds.size === 1 && rows.every((r) => r.group_id !== null) ? [...groupIds][0] : null;
    const groupName =
      soleGroup === null
        ? null
        : (db
            .prepare<[number], { name: string }>('SELECT name FROM groups WHERE id = ?')
            .get(soleGroup)?.name ?? null);
    const verb = batch.payer_id === me.id ? 'to' : 'from';
    recordActivity(
      me.id,
      'payment_undone',
      soleGroup,
      rows[0]?.id ?? null,
      `${me.name} undid a payment of ${amount} ${verb} ${userName(counterpart)}${
        groupName ? ` in ${groupName}` : ''
      }`,
    );
  })();

  notifySettlementUndone(me, {
    payerId: batch.payer_id,
    payeeId: batch.payee_id,
    amountCents: batch.amount_cents,
    currency: batch.currency,
  });
  return c.body(null, 204);
});

export default app;
