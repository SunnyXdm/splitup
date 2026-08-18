import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { APP_ORIGIN, requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type GroupRow } from '../db';
import { groupCreateBody, groupPatchBody, idParam, memberBody } from '../validate';
import { readJson, toGroup } from '../lib/wire';
import { areFriends, groupMemberIds, isMember, memberGroupOr404, recordActivity } from '../lib/expense';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.post('/', async (c) => {
  const me = c.get('user');
  const body = groupCreateBody.parse(await readJson(c));
  const now = nowIso();
  const group = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO groups (name, emoji, currency, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(body.name, body.emoji ?? '🧾', body.currency ?? me.default_currency, me.id, now);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      id,
      me.id,
      now,
    );
    recordActivity(me.id, 'group_created', id, null, `${me.name} created the group '${body.name}'`);
    return db.prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ?').get(id)!;
  })();
  return c.json(toGroup(group, [me.id]));
});

app.patch('/:id', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const body = groupPatchBody.parse(await readJson(c));
  const group = memberGroupOr404(id, me.id);
  // Currency is locked once expenses exist: existing expenses/payments carry
  // the old currency and would fail the group-currency invariant forever.
  if (body.currency !== undefined && body.currency !== group.currency) {
    const hasExpenses = db
      .prepare('SELECT 1 FROM expenses WHERE group_id = ? AND deleted_at IS NULL LIMIT 1')
      .get(id);
    if (hasExpenses) {
      throw new HTTPException(409, {
        message: 'currency is locked once the group has expenses',
      });
    }
  }
  db.transaction(() => {
    db.prepare(
      'UPDATE groups SET name = COALESCE(?, name), emoji = COALESCE(?, emoji), currency = COALESCE(?, currency) WHERE id = ?',
    ).run(body.name ?? null, body.emoji ?? null, body.currency ?? null, id);
    if (body.name !== undefined && body.name !== group.name) {
      recordActivity(
        me.id,
        'group_renamed',
        id,
        null,
        `${me.name} renamed '${group.name}' to '${body.name}'`,
      );
    }
  })();
  const updated = db.prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ?').get(id)!;
  return c.json(toGroup(updated, groupMemberIds(id)));
});

app.delete('/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const group = memberGroupOr404(id, me.id);
  if (group.created_by !== me.id) {
    throw new HTTPException(403, { message: 'only the group creator can delete it' });
  }
  // Deleting a group hides its expenses from every balance view, so it must
  // not be able to erase live debts — same rule as leaving.
  const unsettled = db
    .prepare<[number], { user_id: number }>(
      `SELECT s.user_id FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? AND e.deleted_at IS NULL
       GROUP BY s.user_id, e.currency HAVING SUM(s.paid_cents - s.owed_cents) != 0 LIMIT 1`,
    )
    .get(id);
  if (unsettled) throw new HTTPException(409, { message: 'unsettled' });
  db.transaction(() => {
    // Archive, never destroy: expenses/shares/members stay in the database so
    // nothing is lost; the group simply disappears from everyone's sync.
    // Invite links are revoked so it can't be re-joined.
    db.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
    db.prepare('DELETE FROM group_invites WHERE group_id = ?').run(id);
  })();
  return c.body(null, 204);
});

app.post('/:id/leave', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  memberGroupOr404(id, me.id);
  const { net } = db
    .prepare<[number, number], { net: number }>(
      `SELECT COALESCE(SUM(s.paid_cents - s.owed_cents), 0) AS net
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? AND e.deleted_at IS NULL AND s.user_id = ?`,
    )
    .get(id, me.id)!;
  if (net !== 0) throw new HTTPException(409, { message: 'unsettled' });
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, me.id);
  return c.body(null, 204);
});

app.post('/:id/members', async (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const { userId } = memberBody.parse(await readJson(c));
  const group = memberGroupOr404(id, me.id);
  if (userId === me.id) throw new HTTPException(400, { message: 'you are already a member' });
  // You can only pull in your own friends — not arbitrary user ids.
  if (!areFriends(me.id, userId)) {
    throw new HTTPException(404, { message: 'not found' });
  }
  db.transaction(() => {
    const now = nowIso();
    const added = db
      .prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(id, userId, now).changes > 0;
    if (added) {
      // New member befriends every existing member (both directions), matching
      // the invite-join behavior so cross-group balances stay coherent.
      const addFriend = db.prepare(
        'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
      );
      for (const memberId of groupMemberIds(id)) {
        if (memberId === userId) continue;
        addFriend.run(userId, memberId, now);
        addFriend.run(memberId, userId, now);
      }
      const added = db
        .prepare<[number], { name: string }>('SELECT name FROM users WHERE id = ?')
        .get(userId)!;
      recordActivity(
        me.id,
        'member_joined',
        id,
        null,
        `${me.name} added ${added.name} to ${group.name}`,
      );
    }
  })();
  return c.json(toGroup(group, groupMemberIds(id)));
});

app.delete('/:id/members/:userId', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const targetId = idParam.parse(c.req.param('userId'));
  const group = memberGroupOr404(id, me.id);
  if (!isMember(id, targetId)) throw new HTTPException(404, { message: 'not found' });
  if (targetId === group.created_by) {
    throw new HTTPException(403, { message: 'the group creator cannot be removed' });
  }
  // Same safety rule as leaving: only settled members can be removed, so a
  // mistaken add is instantly fixable but debts can never be kicked away.
  const { net } = db
    .prepare<[number, number], { net: number }>(
      `SELECT COALESCE(SUM(s.paid_cents - s.owed_cents), 0) AS net
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? AND e.deleted_at IS NULL AND s.user_id = ?`,
    )
    .get(id, targetId)!;
  if (net !== 0) throw new HTTPException(409, { message: 'unsettled' });
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(id, targetId);
    const target = db
      .prepare<[number], { name: string }>('SELECT name FROM users WHERE id = ?')
      .get(targetId)!;
    recordActivity(
      me.id,
      'member_removed',
      id,
      null,
      targetId === me.id
        ? `${me.name} left ${group.name}`
        : `${me.name} removed ${target.name} from ${group.name}`,
    );
  })();
  return c.body(null, 204);
});

app.post('/:id/invites', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  memberGroupOr404(id, me.id);
  const token = randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO group_invites (token, group_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(token, id, me.id, nowIso(), new Date(Date.now() + INVITE_TTL_MS).toISOString());
  return c.json({ token, url: `${APP_ORIGIN}/join/${token}` });
});

export default app;
