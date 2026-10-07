import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { GUEST_SUB_PREFIX } from '../auth';
import { db, nowIso, type GroupRow, type RecurringRuleRow, type UserRow } from '../db';
import type { RecurringTemplate } from '../validate';
import { isMember, realMemberIds, recordActivity } from './expense';
import { clearGroupPrefs } from './archive';
import { templateOf } from './recurring';

/**
 * Guest participants: people without Splitup whose share someone tracks
 * inside one group. A guest is an ordinary users row (is_guest = 1) plus one
 * group_members row, so every balance, routing and history path works
 * unchanged. Guests never sign in, are nobody's friend, never get pushes, and
 * can only take part in their own group's expenses and payments. A claim link
 * lets a real account take over the guest's shares (mergeGuestInto).
 */

const NOT_FOUND = () => new HTTPException(404, { message: 'not found' });

export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the user's net in the group is nonzero in any currency. */
export function memberUnsettled(groupId: number, userId: number): boolean {
  return (
    db
      .prepare<[number, number], { currency: string }>(
        `SELECT e.currency FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ? AND e.deleted_at IS NULL AND s.user_id = ?
         GROUP BY e.currency HAVING SUM(s.paid_cents - s.owed_cents) != 0 LIMIT 1`,
      )
      .get(groupId, userId) !== undefined
  );
}

/** A live, unclaimed guest who is a member of this group — 404 otherwise. */
export function guestOr404(groupId: number, userId: number): UserRow {
  const guest = db
    .prepare<[number, number], UserRow>(
      `SELECT * FROM users
       WHERE id = ? AND is_guest = 1 AND guest_of_group = ? AND merged_into IS NULL`,
    )
    .get(userId, groupId);
  if (!guest || !isMember(groupId, userId)) throw NOT_FOUND();
  return guest;
}

export function createGuest(me: UserRow, group: GroupRow, name: string): UserRow {
  return db.transaction(() => {
    const now = nowIso();
    const id = Number(
      db
        .prepare(
          `INSERT INTO users (shoo_sub, email, name, picture, default_currency, created_at,
             is_guest, guest_of_group, created_by)
           VALUES (?, NULL, ?, NULL, ?, ?, 1, ?, ?)`,
        )
        .run(
          `${GUEST_SUB_PREFIX}${randomBytes(16).toString('hex')}`,
          name,
          group.currency,
          now,
          group.id,
          me.id,
        ).lastInsertRowid,
    );
    db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(
      group.id,
      id,
      now,
    );
    recordActivity(me.id, 'guest_added', group.id, null, `${me.name} added guest ${name}`);
    return db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(id)!;
  })();
}

export function renameGuest(me: UserRow, group: GroupRow, guest: UserRow, name: string): UserRow {
  if (name !== guest.name) {
    db.transaction(() => {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, guest.id);
      recordActivity(
        me.id,
        'guest_renamed',
        group.id,
        null,
        `${me.name} renamed guest ${guest.name} to ${name}`,
      );
    })();
  }
  return db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(guest.id)!;
}

/**
 * Removes a settled guest from the group. Only the membership goes: the users
 * row stays so old expenses and history keep their name. Claim links die too.
 */
export function removeGuest(me: UserRow, group: GroupRow, guest: UserRow): void {
  if (memberUnsettled(group.id, guest.id)) {
    throw new HTTPException(409, { message: 'unsettled' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(
      group.id,
      guest.id,
    );
    clearGroupPrefs(group.id, guest.id);
    db.prepare('DELETE FROM guest_claims WHERE guest_id = ?').run(guest.id);
    recordActivity(
      me.id,
      'guest_removed',
      group.id,
      null,
      `${me.name} removed guest ${guest.name} from ${group.name}`,
    );
  })();
}

export function createClaimToken(me: UserRow, guest: UserRow): string {
  const token = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO guest_claims (token, guest_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, guest.id, me.id, nowIso(), new Date(Date.now() + CLAIM_TTL_MS).toISOString());
  return token;
}

// ---------------------------------------------------------------------------
// Claiming (merge)
// ---------------------------------------------------------------------------

/**
 * A recurring template with every mention of `from` turned into `to`. When
 * `to` is already in the split, the two entries combine: payers' cents and
 * split values (exact cents, percent basis points, share counts) add up, and
 * participants dedupe. Totals are unchanged, so the template stays valid —
 * though an EQUAL split now charges one person where it charged two.
 */
export function remapTemplateUser(
  template: RecurringTemplate,
  from: number,
  to: number,
): RecurringTemplate {
  const swap = (id: number) => (id === from ? to : id);
  const sumBy = <T extends { userId: number }>(items: T[], key: keyof T & string): T[] => {
    const out: T[] = [];
    for (const item of items) {
      const userId = swap(item.userId);
      const prev = out.find((x) => x.userId === userId);
      if (prev) (prev[key] as number) += item[key] as number;
      else out.push({ ...item, userId });
    }
    return out;
  };
  const split = template.split;
  return {
    ...template,
    split: {
      ...split,
      participants: [...new Set(split.participants.map(swap))],
      ...(split.values !== undefined ? { values: sumBy(split.values, 'value') } : {}),
      payers: sumBy(split.payers, 'cents'),
    },
  };
}

/** Shares with merged guests replaced by their account (duplicates combined). */
export function resolveMergedShares<
  S extends { userId: number; paidCents: number; owedCents: number },
>(shares: S[]): S[] {
  const target = db.prepare<[number], { merged_into: number | null }>(
    'SELECT merged_into FROM users WHERE id = ?',
  );
  const resolve = (id: number) => {
    let current = id;
    // A guest merges into a real account, which never merges again; the
    // bound only guards against a hand-edited cycle.
    for (let i = 0; i < 8; i++) {
      const next = target.get(current)?.merged_into ?? null;
      if (next === null) break;
      current = next;
    }
    return current;
  };
  const out: S[] = [];
  for (const s of shares) {
    const userId = resolve(s.userId);
    const prev = out.find((x) => x.userId === userId);
    if (prev) {
      prev.paidCents += s.paidCents;
      prev.owedCents += s.owedCents;
    } else {
      out.push({ ...s, userId });
    }
  }
  return out;
}

/** Live per-(group, currency, user) nets across the given groups. */
function ledgerNets(groupIds: number[]): Map<string, number> {
  const nets = new Map<string, number>();
  const stmt = db.prepare<[number], { user_id: number; currency: string; net: number }>(
    `SELECT s.user_id, e.currency, SUM(s.paid_cents - s.owed_cents) AS net
     FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
     WHERE e.group_id = ? AND e.deleted_at IS NULL
     GROUP BY s.user_id, e.currency`,
  );
  for (const gid of groupIds) {
    for (const r of stmt.all(gid)) {
      if (r.net !== 0) nets.set(`${gid}:${r.currency}:${r.user_id}`, r.net);
    }
  }
  return nets;
}

/**
 * Hands a guest's whole ledger to a real account, atomically:
 *
 * - expense shares move to `me`; where both held a share in the same expense,
 *   paid and owed are summed into my row (nets add, so conservation holds);
 * - settle-up batches, recurring templates and group membership follow;
 * - I befriend the group's real members, exactly like an invite join;
 * - the guest row stays (history snapshots still name it) with merged_into
 *   set, and its claim links are revoked.
 *
 * Revision snapshots are history and keep the guest's id; restoring one maps
 * it through merged_into (resolveMergedShares).
 *
 * Before commit, every (group, currency) net is re-derived: it must equal the
 * old one with the guest's net added to mine, or the whole merge rolls back.
 * Suggested settlements may still re-route, since the sweep orders people by
 * user id and my id differs from the guest's — totals never change.
 */
export function mergeGuestInto(guest: UserRow, me: UserRow, group: GroupRow): void {
  db.transaction(() => {
    const now = nowIso();
    const groupIds = [
      ...new Set([
        group.id,
        ...db
          .prepare<[number], { group_id: number | null }>(
            `SELECT DISTINCT e.group_id FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
             WHERE s.user_id = ?`,
          )
          .all(guest.id)
          .flatMap((r) => (r.group_id === null ? [] : [r.group_id])),
      ]),
    ];
    const before = ledgerNets(groupIds);
    const wasMember = isMember(group.id, me.id);

    // Expenses the merge touches get a fresh updated_at, so stale clients
    // (edit conflicts, settle watermarks) notice the change.
    db.prepare(
      `UPDATE expenses SET updated_at = ?
       WHERE id IN (SELECT expense_id FROM expense_shares WHERE user_id = ?)`,
    ).run(now, guest.id);
    db.prepare(
      `UPDATE expense_shares SET
         paid_cents = paid_cents + (SELECT g.paid_cents FROM expense_shares g
           WHERE g.expense_id = expense_shares.expense_id AND g.user_id = ?),
         owed_cents = owed_cents + (SELECT g.owed_cents FROM expense_shares g
           WHERE g.expense_id = expense_shares.expense_id AND g.user_id = ?)
       WHERE user_id = ?
         AND expense_id IN (SELECT expense_id FROM expense_shares WHERE user_id = ?)`,
    ).run(guest.id, guest.id, me.id, guest.id);
    db.prepare(
      `DELETE FROM expense_shares WHERE user_id = ?
       AND expense_id IN (SELECT expense_id FROM expense_shares WHERE user_id = ?)`,
    ).run(guest.id, me.id);
    db.prepare('UPDATE expense_shares SET user_id = ? WHERE user_id = ?').run(me.id, guest.id);

    db.prepare('UPDATE settlement_batches SET payer_id = ? WHERE payer_id = ?').run(
      me.id,
      guest.id,
    );
    db.prepare('UPDATE settlement_batches SET payee_id = ? WHERE payee_id = ?').run(
      me.id,
      guest.id,
    );

    const rules = db
      .prepare<[number], RecurringRuleRow>('SELECT * FROM recurring_rules WHERE group_id = ?')
      .all(group.id);
    const saveTemplate = db.prepare(
      'UPDATE recurring_rules SET template = ?, updated_at = ? WHERE id = ?',
    );
    for (const rule of rules) {
      const template = templateOf(rule);
      const mentions =
        template.split.participants.includes(guest.id) ||
        template.split.payers.some((p) => p.userId === guest.id) ||
        (template.split.values ?? []).some((v) => v.userId === guest.id);
      if (!mentions) continue;
      saveTemplate.run(
        JSON.stringify(remapTemplateUser(template, guest.id, me.id)),
        now,
        rule.id,
      );
    }

    if (!wasMember) {
      const members = realMemberIds(group.id);
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
    }
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(
      group.id,
      guest.id,
    );
    clearGroupPrefs(group.id, guest.id);
    db.prepare('UPDATE users SET merged_into = ? WHERE id = ?').run(me.id, guest.id);
    db.prepare('DELETE FROM guest_claims WHERE guest_id = ?').run(guest.id);
    recordActivity(
      me.id,
      'guest_claimed',
      group.id,
      null,
      `${guest.name}'s expenses now belong to ${me.name}`,
    );

    // Conservation: the guest's nets moved onto mine; nobody else changed.
    const expected = new Map<string, number>();
    for (const [key, net] of before) {
      const [gid, currency, uid] = key.split(':');
      const owner = Number(uid) === guest.id ? me.id : Number(uid);
      const k = `${gid}:${currency}:${owner}`;
      expected.set(k, (expected.get(k) ?? 0) + net);
    }
    for (const [k, v] of expected) if (v === 0) expected.delete(k);
    const after = ledgerNets(groupIds);
    const same =
      after.size === expected.size && [...after].every(([k, v]) => expected.get(k) === v);
    if (!same) throw new HTTPException(500, { message: 'merge would change balances' });
  })();
}
