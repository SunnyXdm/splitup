import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type GroupRow } from '../db';
import { inviteTokenParam } from '../validate';
import { toGroup, type InvitePreview } from '../lib/wire';
import { groupMemberIds, isMember, recordActivity } from '../lib/expense';

interface InviteRow {
  token: string;
  group_id: number;
  created_by: number;
  created_at: string;
  expires_at: string;
}

/** Valid, unexpired invite — malformed/unknown/expired all → 404. */
function inviteOr404(rawToken: string): InviteRow {
  const parsed = inviteTokenParam.safeParse(rawToken);
  const invite = parsed.success
    ? db
        .prepare<[string, string], InviteRow>(
          'SELECT * FROM group_invites WHERE token = ? AND expires_at > ?',
        )
        .get(parsed.data, nowIso())
    : undefined;
  if (!invite) throw new HTTPException(404, { message: 'invite not found or expired' });
  return invite;
}

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.get('/:token', (c) => {
  const me = c.get('user');
  const invite = inviteOr404(c.req.param('token'));
  const group = db
    .prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ?')
    .get(invite.group_id)!;
  const memberNames = db
    .prepare<[number], { name: string }>(
      'SELECT u.name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at, u.id',
    )
    .all(group.id)
    .map((r) => r.name);
  const preview: InvitePreview = {
    token: invite.token,
    groupId: group.id,
    groupName: group.name,
    emoji: group.emoji,
    memberCount: memberNames.length,
    memberNames,
    // Judged server-side at request time; client caches can be stale.
    alreadyMember: isMember(group.id, me.id),
  };
  return c.json(preview);
});

app.post('/:token/join', (c) => {
  const me = c.get('user');
  const invite = inviteOr404(c.req.param('token'));
  const group = db
    .prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ?')
    .get(invite.group_id)!;
  if (!isMember(group.id, me.id)) {
    db.transaction(() => {
      const now = nowIso();
      const members = groupMemberIds(group.id);
      db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(
        group.id,
        me.id,
        now,
      );
      const addFriend = db.prepare(
        'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
      );
      for (const memberId of members) {
        if (memberId === me.id) continue;
        addFriend.run(me.id, memberId, now);
        addFriend.run(memberId, me.id, now);
      }
      recordActivity(me.id, 'member_joined', group.id, null, `${me.name} joined ${group.name}`);
    })();
  }
  return c.json(toGroup(group, groupMemberIds(group.id)));
});

export default app;
