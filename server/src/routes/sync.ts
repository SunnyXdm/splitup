import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../auth';
import {
  db,
  nowIso,
  type ActivityRow,
  type ExpenseRow,
  type GroupRow,
  type ShareRow,
  type UserRow,
} from '../db';
import {
  toActivity,
  toExpense,
  toGroup,
  toMe,
  toUser,
  type SyncData,
  type User,
} from '../lib/wire';

/** Non-deleted expenses visible to me: my groups' + non-group ones I'm part of. */
const VISIBLE_EXPENSES_WHERE = `
  e.deleted_at IS NULL AND (
    e.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
    OR (e.group_id IS NULL AND EXISTS (
      SELECT 1 FROM expense_shares mine WHERE mine.expense_id = e.id AND mine.user_id = ?
    ))
  )`;

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.get('/', (c) => {
  const me = c.get('user');

  const friendIds = db
    .prepare<[number], { friend_id: number }>(
      'SELECT friend_id FROM friendships WHERE user_id = ? ORDER BY friend_id',
    )
    .all(me.id)
    .map((r) => r.friend_id);

  const groupRows = db
    .prepare<[number], GroupRow>(
      `SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id = g.id AND g.deleted_at IS NULL
       WHERE gm.user_id = ? ORDER BY g.created_at, g.id`,
    )
    .all(me.id);

  const memberRows = db
    .prepare<[number], { group_id: number; user_id: number }>(
      `SELECT gm.group_id, gm.user_id FROM group_members gm
       WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY gm.joined_at, gm.user_id`,
    )
    .all(me.id);
  const membersByGroup = new Map<number, number[]>();
  for (const m of memberRows) {
    const list = membersByGroup.get(m.group_id);
    if (list) list.push(m.user_id);
    else membersByGroup.set(m.group_id, [m.user_id]);
  }

  const expenseRows = db
    .prepare<[number, number], ExpenseRow>(
      `SELECT e.* FROM expenses e WHERE ${VISIBLE_EXPENSES_WHERE} ORDER BY e.date DESC, e.id DESC`,
    )
    .all(me.id, me.id);

  const shareRows = db
    .prepare<[number, number], ShareRow>(
      `SELECT s.* FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE ${VISIBLE_EXPENSES_WHERE} ORDER BY s.expense_id, s.user_id`,
    )
    .all(me.id, me.id);
  const sharesByExpense = new Map<number, ShareRow[]>();
  for (const s of shareRows) {
    const list = sharesByExpense.get(s.expense_id);
    if (list) list.push(s);
    else sharesByExpense.set(s.expense_id, [s]);
  }

  // users = me + friends + co-members (+ share-holders of visible expenses, so
  // shares never reference a user the client doesn't have, e.g. ex-members).
  const userIds = new Set<number>([me.id, ...friendIds]);
  for (const m of memberRows) userIds.add(m.user_id);
  for (const s of shareRows) userIds.add(s.user_id);
  const userStmt = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?');
  const users: User[] = [];
  for (const uid of [...userIds].sort((a, b) => a - b)) {
    const row = userStmt.get(uid);
    if (row) users.push(toUser(row));
  }

  const activityRows = db
    .prepare<[number, number, number], ActivityRow>(
      `SELECT a.* FROM activity a
       WHERE a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
          OR a.actor_id = ?
          OR (a.expense_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM expense_shares s WHERE s.expense_id = a.expense_id AND s.user_id = ?
          ))
       ORDER BY a.id DESC LIMIT 200`,
    )
    .all(me.id, me.id, me.id);

  const payload: SyncData = {
    me: toMe(me),
    users,
    friendIds,
    groups: groupRows.map((g) => toGroup(g, membersByGroup.get(g.id) ?? [])),
    expenses: expenseRows.map((e) => toExpense(e, sharesByExpense.get(e.id) ?? [])),
    activity: activityRows.map(toActivity),
    syncedAt: nowIso(),
  };
  return c.json(payload);
});

export default app;
