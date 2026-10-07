import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { APP_ORIGIN, requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type FriendRequestRow, type UserRow } from '../db';
import { friendBody, idParam, inviteTokenParam } from '../validate';
import { rateLimit } from '../security';
import { readJson, toUser } from '../lib/wire';
import { areFriends, recordActivity } from '../lib/expense';

interface FriendInviteRow {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

/** Valid, unexpired friend invite — malformed/unknown/expired all → 404. */
function friendInviteOr404(rawToken: string): FriendInviteRow {
  const parsed = inviteTokenParam.safeParse(rawToken);
  const invite = parsed.success
    ? db
        .prepare<[string, string], FriendInviteRow>(
          'SELECT * FROM friend_invites WHERE token = ? AND expires_at > ?',
        )
        .get(parsed.data, nowIso())
    : undefined;
  if (!invite) throw new HTTPException(404, { message: 'invite not found or expired' });
  return invite;
}

/**
 * Create the friendship in both directions and drop any pending requests
 * between the two; each side gets its own (actor-private) activity row, only
 * when the friendship is new.
 */
function befriend(me: UserRow, friend: UserRow): void {
  db.transaction(() => {
    const now = nowIso();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    );
    const added = insert.run(me.id, friend.id, now).changes > 0;
    insert.run(friend.id, me.id, now);
    deleteRequests(me, friend);
    if (added) {
      recordActivity(me.id, 'friend_added', null, null, `You became friends with ${friend.name}`);
      recordActivity(friend.id, 'friend_added', null, null, `You became friends with ${me.name}`);
    }
  })();
}

/** Remove pending requests in either direction between two users. */
function deleteRequests(a: UserRow, b: UserRow): void {
  const del = db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_email = ?');
  if (b.email) del.run(a.id, b.email.toLowerCase());
  if (a.email) del.run(b.id, a.email.toLowerCase());
}

/** A pending request from `fromId` addressed to `to`'s email. */
const requestExists = (fromId: number, to: UserRow) =>
  to.email !== null &&
  db
    .prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_email = ?')
    .get(fromId, to.email.toLowerCase()) !== undefined;

const MAX_PENDING_OUTGOING = 50;

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.post('/invites', (c) => {
  const me = c.get('user');
  const token = randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO friend_invites (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(token, me.id, nowIso(), new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  return c.json({ token, url: `${APP_ORIGIN}/friend/${token}` });
});

app.get('/invites/:token', (c) => {
  const me = c.get('user');
  const invite = friendInviteOr404(c.req.param('token'));
  const inviter = db
    .prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?')
    .get(invite.user_id)!;
  // Relationship judged server-side at request time — the client's cached sync
  // data can be stale (e.g. the friendship is newer than the last sync).
  const isSelf = invite.user_id === me.id;
  const alreadyFriends =
    !isSelf &&
    db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(
      me.id,
      inviter.id,
    ) !== undefined;
  return c.json({ token: invite.token, inviter: toUser(inviter), isSelf, alreadyFriends });
});

app.post('/invites/:token/accept', (c) => {
  const me = c.get('user');
  const invite = friendInviteOr404(c.req.param('token'));
  if (invite.user_id === me.id) {
    throw new HTTPException(400, { message: 'this is your own invite link' });
  }
  const inviter = db
    .prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?')
    .get(invite.user_id)!;
  // An invite link is the inviter's consent: befriend directly.
  befriend(me, inviter);
  return c.json({ user: toUser(inviter) });
});

// Requests by email are cheap to spam and would otherwise probe the user
// table; cap them per session (on top of the global limiter).
app.post('/', rateLimit(30, 'session', 60 * 60 * 1000), async (c) => {
  const me = c.get('user');
  const { email } = friendBody.parse(await readJson(c));
  if (email === me.email?.toLowerCase()) {
    throw new HTTPException(400, { message: 'you cannot add yourself' });
  }
  const friend = db
    .prepare<[string, number], UserRow>(
      'SELECT * FROM users WHERE lower(email) = ? AND id != ? ORDER BY id LIMIT 1',
    )
    .get(email, me.id);
  // Existing friends are already visible to me — no new information leaks.
  if (friend && areFriends(me.id, friend.id)) {
    return c.json({ status: 'friends', user: toUser(friend) });
  }
  // They already asked me: my request is the acceptance.
  if (friend && requestExists(friend.id, me)) {
    befriend(me, friend);
    return c.json({ status: 'friends', user: toUser(friend) });
  }
  // Everything else is stored by email whether or not an account exists, so
  // the response (and my outgoing list) never reveals account existence.
  const duplicate = db
    .prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_email = ?')
    .get(me.id, email);
  if (!duplicate) {
    const { n } = db
      .prepare<[number], { n: number }>(
        'SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?',
      )
      .get(me.id)!;
    if (n >= MAX_PENDING_OUTGOING) {
      throw new HTTPException(429, { message: 'too many pending friend requests' });
    }
    db.prepare(
      'INSERT INTO friend_requests (from_id, to_email, created_at) VALUES (?, ?, ?)',
    ).run(me.id, email, nowIso());
  }
  return c.json({ status: 'requested' });
});

const requestOr404 = (rawId: string) => {
  const req = db
    .prepare<[number], FriendRequestRow>('SELECT * FROM friend_requests WHERE id = ?')
    .get(idParam.parse(rawId));
  if (!req) throw new HTTPException(404, { message: 'not found' });
  return req;
};

app.post('/requests/:id/accept', (c) => {
  const me = c.get('user');
  const req = requestOr404(c.req.param('id'));
  if (me.email === null || req.to_email !== me.email.toLowerCase() || req.from_id === me.id) {
    throw new HTTPException(404, { message: 'not found' });
  }
  const friend = db
    .prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?')
    .get(req.from_id)!;
  befriend(me, friend);
  return c.json({ status: 'friends', user: toUser(friend) });
});

// Cancels my outgoing request or declines one addressed to my email; any
// other request id (or an already-gone one) is 404, like accept.
app.delete('/requests/:id', (c) => {
  const me = c.get('user');
  const req = requestOr404(c.req.param('id'));
  const mine = req.from_id === me.id;
  const toMe = me.email !== null && req.to_email === me.email.toLowerCase();
  if (!mine && !toMe) throw new HTTPException(404, { message: 'not found' });
  db.prepare('DELETE FROM friend_requests WHERE id = ?').run(req.id);
  return c.body(null, 204);
});

export default app;
