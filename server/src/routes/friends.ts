import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { APP_ORIGIN, requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type UserRow } from '../db';
import { friendBody, inviteTokenParam } from '../validate';
import { readJson, toUser } from '../lib/wire';
import { recordActivity } from '../lib/expense';

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

/** Create the friendship in both directions; activity only when it's new. */
function befriend(meId: number, friend: UserRow): void {
  db.transaction(() => {
    const now = nowIso();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    );
    const added = insert.run(meId, friend.id, now).changes > 0;
    insert.run(friend.id, meId, now);
    if (added) {
      recordActivity(meId, 'friend_added', null, null, `You became friends with ${friend.name}`);
    }
  })();
}

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
  befriend(me.id, inviter);
  return c.json({ user: toUser(inviter) });
});

app.post('/', async (c) => {
  const me = c.get('user');
  const { email } = friendBody.parse(await readJson(c));
  const friend = db.prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?').get(email);
  if (!friend) throw new HTTPException(404, { message: 'no user with that email' });
  if (friend.id === me.id) throw new HTTPException(400, { message: 'you cannot add yourself' });
  befriend(me.id, friend);
  return c.json({ user: toUser(friend) });
});

export default app;
