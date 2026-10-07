import { db, nowIso } from '../db';

/**
 * Personal group archive: a per-user flag that only hides a group from that
 * user's Home. Archived groups stay in sync and in every balance calculation.
 */

/** The user's archived_at for a group, or null when not archived. */
export function archivedAtFor(groupId: number, userId: number): string | null {
  return (
    db
      .prepare<[number, number], { archived_at: string | null }>(
        'SELECT archived_at FROM group_prefs WHERE group_id = ? AND user_id = ?',
      )
      .get(groupId, userId)?.archived_at ?? null
  );
}

/** Archives (or re-archives, keeping the original timestamp) a group for one user. */
export function archiveGroup(groupId: number, userId: number): string {
  db.prepare(
    `INSERT INTO group_prefs (group_id, user_id, archived_at) VALUES (?, ?, ?)
     ON CONFLICT (group_id, user_id)
       DO UPDATE SET archived_at = COALESCE(archived_at, excluded.archived_at)`,
  ).run(groupId, userId, nowIso());
  return archivedAtFor(groupId, userId)!;
}

export function unarchiveGroup(groupId: number, userId: number): void {
  db.prepare('UPDATE group_prefs SET archived_at = NULL WHERE group_id = ? AND user_id = ?').run(
    groupId,
    userId,
  );
}

/** Drops a user's prefs for a group (they left or were removed). */
export function clearGroupPrefs(groupId: number, userId: number): void {
  db.prepare('DELETE FROM group_prefs WHERE group_id = ? AND user_id = ?').run(groupId, userId);
}

/**
 * New activity must not stay hidden from the people it affects: after a write
 * to a group's ledger, members who archived the group get it back on Home when
 * they took part in the change (`participantIds`) or their group net is now
 * nonzero in any currency. Everyone else's archive is left alone. Call inside
 * the write's transaction, after the ledger rows are written.
 */
export function unarchiveAffected(groupId: number, participantIds: Iterable<number>): void {
  const archived = db
    .prepare<[number], { user_id: number }>(
      `SELECT p.user_id FROM group_prefs p
       JOIN group_members gm ON gm.group_id = p.group_id AND gm.user_id = p.user_id
       WHERE p.group_id = ? AND p.archived_at IS NOT NULL`,
    )
    .all(groupId)
    .map((r) => r.user_id);
  if (archived.length === 0) return;
  const participants = new Set(participantIds);
  const unsettled = db.prepare<[number, number], { one: number }>(
    `SELECT 1 AS one FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
     WHERE e.group_id = ? AND e.deleted_at IS NULL AND s.user_id = ?
     GROUP BY e.currency HAVING SUM(s.paid_cents - s.owed_cents) != 0 LIMIT 1`,
  );
  for (const userId of archived) {
    if (participants.has(userId) || unsettled.get(groupId, userId) !== undefined) {
      unarchiveGroup(groupId, userId);
    }
  }
}

/** Users with a nonzero paid or owed amount in a set of shares. */
export const participantsOf = (
  shares: readonly { userId: number; paidCents: number; owedCents: number }[],
): number[] => shares.filter((s) => s.paidCents !== 0 || s.owedCents !== 0).map((s) => s.userId);
