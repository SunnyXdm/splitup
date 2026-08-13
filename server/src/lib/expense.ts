import { HTTPException } from 'hono/http-exception';
import { db, nowIso, type ExpenseRow, type GroupRow, type ShareRow, type UserRow } from '../db';
import type { ExpenseBody } from '../validate';
import { toExpense, type ActivityType, type Expense } from './wire';

const NOT_FOUND = () => new HTTPException(404, { message: 'not found' });

export function isMember(groupId: number, userId: number): boolean {
  return (
    db
      .prepare<[number, number], { one: number }>(
        'SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ?',
      )
      .get(groupId, userId) !== undefined
  );
}

export function groupMemberIds(groupId: number): number[] {
  return db
    .prepare<[number], { user_id: number }>(
      'SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id',
    )
    .all(groupId)
    .map((r) => r.user_id);
}

/** The group, but only when it exists AND the caller is a member — 404 otherwise (no existence leak). */
export function memberGroupOr404(groupId: number, userId: number): GroupRow {
  const group = db
    .prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
    .get(groupId);
  if (!group || !isMember(groupId, userId)) throw NOT_FOUND();
  return group;
}

export function areFriends(userId: number, friendId: number): boolean {
  return (
    db
      .prepare<[number, number], { one: number }>(
        'SELECT 1 AS one FROM friendships WHERE user_id = ? AND friend_id = ?',
      )
      .get(userId, friendId) !== undefined
  );
}

export function recordActivity(
  actorId: number,
  type: ActivityType,
  groupId: number | null,
  expenseId: number | null,
  summary: string,
): void {
  db.prepare(
    'INSERT INTO activity (actor_id, type, group_id, expense_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(actorId, type, groupId, expenseId, summary, nowIso());
}

export function sharesOf(expenseId: number): ShareRow[] {
  return db
    .prepare<[number], ShareRow>(
      'SELECT * FROM expense_shares WHERE expense_id = ? ORDER BY user_id',
    )
    .all(expenseId);
}

export function insertShares(
  expenseId: number,
  shares: { userId: number; paidCents: number; owedCents: number }[],
): void {
  const stmt = db.prepare(
    'INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents) VALUES (?, ?, ?, ?)',
  );
  for (const s of shares) stmt.run(expenseId, s.userId, s.paidCents, s.owedCents);
}

export function expenseWire(id: number): Expense {
  const row = db.prepare<[number], ExpenseRow>('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!row) throw NOT_FOUND();
  return toExpense(row, sharesOf(id));
}

/**
 * Loads a non-deleted expense the caller may edit/delete: a member of its group,
 * or (non-group) one of the two share-holders. Anything else → 404.
 */
export function editableExpenseOr404(me: UserRow, id: number): ExpenseRow {
  const row = db
    .prepare<[number], ExpenseRow>('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL')
    .get(id);
  if (!row) throw NOT_FOUND();
  if (row.group_id !== null) {
    if (!isMember(row.group_id, me.id)) throw NOT_FOUND();
  } else if (!sharesOf(row.id).some((s) => s.user_id === me.id)) {
    throw NOT_FOUND();
  }
  return row;
}

/**
 * Semantic checks beyond zod for an expense body. Returns the group (null for
 * non-group). 404 when the caller isn't a member of the target group; 400 for
 * currency/participant violations.
 */
export function checkExpenseInput(me: UserRow, body: ExpenseBody): GroupRow | null {
  if (body.groupId !== null) {
    const group = memberGroupOr404(body.groupId, me.id);
    if (body.currency !== group.currency) {
      throw new HTTPException(400, { message: 'group expenses must use the group currency' });
    }
    const members = new Set(groupMemberIds(group.id));
    for (const s of body.shares) {
      if (!members.has(s.userId)) {
        throw new HTTPException(400, { message: 'every share user must be a group member' });
      }
    }
    return group;
  }
  const ids = body.shares.map((s) => s.userId);
  if (!ids.includes(me.id)) {
    throw new HTTPException(400, { message: 'you must be part of the expense' });
  }
  const other = ids.find((uid) => uid !== me.id);
  if (other === undefined || !areFriends(me.id, other)) {
    throw new HTTPException(400, { message: 'you can only split with a friend' });
  }
  return null;
}

export function userName(id: number): string {
  return (
    db.prepare<[number], { name: string }>('SELECT name FROM users WHERE id = ?').get(id)?.name ??
    'Someone'
  );
}

function groupName(groupId: number): string | null {
  return (
    db.prepare<[number], { name: string }>('SELECT name FROM groups WHERE id = ?').get(groupId)
      ?.name ?? null
  );
}

/** " in <group>" for group expenses, " with <other>" for 1:1 ones. */
function expenseContext(groupId: number | null, shareUserIds: number[], actorId: number): string {
  if (groupId !== null) {
    const name = groupName(groupId);
    return name ? ` in ${name}` : '';
  }
  const other = shareUserIds.find((uid) => uid !== actorId);
  return other === undefined ? '' : ` with ${userName(other)}`;
}

export function expenseSummary(
  verb: 'added' | 'updated' | 'deleted',
  actor: UserRow,
  description: string,
  groupId: number | null,
  shareUserIds: number[],
): string {
  return `${actor.name} ${verb} '${description}'${expenseContext(groupId, shareUserIds, actor.id)}`;
}

export function paymentSummary(
  shares: { userId: number; paidCents: number; owedCents: number }[],
  groupId: number | null,
): string {
  const payer = shares.find((s) => s.paidCents > 0);
  const recipient = shares.find((s) => s.owedCents > 0);
  const base = `${payer ? userName(payer.userId) : 'Someone'} settled up with ${
    recipient ? userName(recipient.userId) : 'someone'
  }`;
  if (groupId === null) return base;
  const name = groupName(groupId);
  return name ? `${base} in ${name}` : base;
}
