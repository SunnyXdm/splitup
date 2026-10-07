import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso, type GroupRow, type UserRow } from '../db';
import { inviteTokenParam } from '../validate';
import { toGroup, toUser, type GuestClaimPreview } from '../lib/wire';
import { groupMemberIds, isMember } from '../lib/expense';
import { guestOr404, mergeGuestInto } from '../lib/guests';
import { archivedAtFor } from '../lib/archive';

interface ClaimRow {
  token: string;
  guest_id: number;
  created_by: number;
  created_at: string;
  expires_at: string;
}

const NOT_FOUND = () => new HTTPException(404, { message: 'claim link not found or expired' });

/**
 * A usable claim: valid unexpired token, its guest still an unclaimed member
 * of a live group. Malformed / unknown / expired / used all → 404.
 */
function claimOr404(rawToken: string): { claim: ClaimRow; guest: UserRow; group: GroupRow } {
  const parsed = inviteTokenParam.safeParse(rawToken);
  const claim = parsed.success
    ? db
        .prepare<[string, string], ClaimRow>(
          'SELECT * FROM guest_claims WHERE token = ? AND expires_at > ?',
        )
        .get(parsed.data, nowIso())
    : undefined;
  if (!claim) throw NOT_FOUND();
  const groupId = db
    .prepare<[number], { guest_of_group: number | null }>(
      'SELECT guest_of_group FROM users WHERE id = ?',
    )
    .get(claim.guest_id)?.guest_of_group;
  const group =
    groupId == null
      ? undefined
      : db
          .prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
          .get(groupId);
  if (!group) throw NOT_FOUND();
  try {
    return { claim, guest: guestOr404(group.id, claim.guest_id), group };
  } catch {
    throw NOT_FOUND();
  }
}

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.get('/:token', (c) => {
  const me = c.get('user');
  const { claim, guest, group } = claimOr404(c.req.param('token'));
  const inviter = db
    .prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?')
    .get(claim.created_by)!;
  const preview: GuestClaimPreview = {
    token: claim.token,
    guest: toUser(guest),
    groupId: group.id,
    groupName: group.name,
    emoji: group.emoji,
    inviter: toUser(inviter),
    alreadyMember: isMember(group.id, me.id),
  };
  return c.json(preview);
});

app.post('/:token/accept', (c) => {
  const me = c.get('user');
  const { claim, guest, group } = claimOr404(c.req.param('token'));
  // Whoever shared the link is vouching that someone ELSE is this guest.
  if (claim.created_by === me.id) {
    throw new HTTPException(400, { message: 'this is your own claim link' });
  }
  mergeGuestInto(guest, me, group);
  return c.json({
    group: toGroup(group, groupMemberIds(group.id), archivedAtFor(group.id, me.id)),
  });
});

export default app;
