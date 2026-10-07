import { db, nowIso } from '../db';

/**
 * THE way two accounts become friends — friend requests and invites, group
 * adds and joins, guest claims alike. Creates the friendship in both
 * directions and drops every pending request between the pair (either
 * direction; requests are addressed by email), so nothing stays "pending"
 * between people who are already friends. Call inside the caller's
 * transaction. Returns whether the friendship is new.
 */
export function befriendPair(a: number, b: number, now: string = nowIso()): boolean {
  if (a === b) return false;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
  );
  const added = insert.run(a, b, now).changes > 0;
  insert.run(b, a, now);
  deletePendingRequests(a, b);
  return added;
}

/** Removes pending friend requests in either direction between two users. */
export function deletePendingRequests(a: number, b: number): void {
  const del = db.prepare(
    `DELETE FROM friend_requests
     WHERE from_id = ? AND to_email = (SELECT lower(email) FROM users WHERE id = ?)`,
  );
  del.run(a, b);
  del.run(b, a);
}

/**
 * My outgoing requests that still count against the pending quota: those not
 * yet resolved by a friendship with the account behind that email.
 */
export function pendingOutgoingCount(meId: number): number {
  return db
    .prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM friend_requests r
       WHERE r.from_id = ? AND NOT EXISTS (
         SELECT 1 FROM friendships f JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = r.from_id AND lower(u.email) = r.to_email
       )`,
    )
    .get(meId)!.n;
}
