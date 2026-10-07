import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../auth';
import {
  db,
  nowIso,
  type ActivityRow,
  type ExpenseRow,
  type FriendRequestRow,
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
import { receiptScanEnabled } from '../receipts';

/**
 * Non-deleted expenses visible to me: my live groups' + non-group ones I'm
 * part of. Deleted groups' expenses are excluded to match the groups list —
 * otherwise the client receives rows whose group it cannot see and silently
 * drops them from friend/total balances.
 */
const VISIBLE_EXPENSES_WHERE = `
  e.deleted_at IS NULL AND (
    e.group_id IN (
      SELECT gm.group_id FROM group_members gm
      JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
      WHERE gm.user_id = ?
    )
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
       WHERE gm.group_id IN (
         SELECT mine.group_id FROM group_members mine
         JOIN groups g ON g.id = mine.group_id AND g.deleted_at IS NULL
         WHERE mine.user_id = ?
       )
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
      // Deleted groups' activity is dropped like their expenses and members;
      // history from groups I merely left still shows (it's my own past).
      `SELECT a.* FROM activity a
       WHERE (a.group_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM groups g WHERE g.id = a.group_id AND g.deleted_at IS NOT NULL
         ))
         AND (
           a.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
           OR a.actor_id = ?
           OR (a.expense_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM expense_shares s WHERE s.expense_id = a.expense_id AND s.user_id = ?
           ))
         )
       ORDER BY a.id DESC LIMIT 200`,
    )
    .all(me.id, me.id, me.id);

  // Pending friend requests, matched to me by email at query time (so one
  // sent before I signed up shows up now). Incoming ones from people I'm
  // already friends with (e.g. via a group join) are moot and hidden.
  const myEmail = me.email?.toLowerCase() ?? null;
  const incoming =
    myEmail === null
      ? []
      : db
          .prepare<[string, number, number], UserRow & { req_id: number; req_created_at: string }>(
            `SELECT u.*, r.id AS req_id, r.created_at AS req_created_at
             FROM friend_requests r JOIN users u ON u.id = r.from_id
             WHERE r.to_email = ? AND r.from_id != ? AND NOT EXISTS (
               SELECT 1 FROM friendships f WHERE f.user_id = ? AND f.friend_id = r.from_id
             )
             ORDER BY r.created_at DESC, r.id DESC`,
          )
          .all(myEmail, me.id, me.id)
          .map((r) => ({ id: r.req_id, user: toUser(r), createdAt: r.req_created_at }));
  // Outgoing is reported verbatim — only what I typed, never whether it maps
  // to an account. Emails of people already my friends are hidden; their
  // emails are in my payload anyway, so that reveals nothing new.
  const outgoing = db
    .prepare<[number, number], FriendRequestRow>(
      `SELECT r.* FROM friend_requests r
       WHERE r.from_id = ? AND NOT EXISTS (
         SELECT 1 FROM friendships f JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND lower(u.email) = r.to_email
       )
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all(me.id, me.id)
    .map((r) => ({ id: r.id, email: r.to_email, createdAt: r.created_at }));

  const payload: SyncData = {
    me: toMe(me),
    users,
    friendIds,
    groups: groupRows.map((g) => toGroup(g, membersByGroup.get(g.id) ?? [])),
    expenses: expenseRows.map((e) => toExpense(e, sharesByExpense.get(e.id) ?? [])),
    activity: activityRows.map(toActivity),
    friendRequests: { incoming, outgoing },
    features: { receiptScan: receiptScanEnabled() },
    syncedAt: nowIso(),
  };
  return c.json(payload);
});

export default app;
