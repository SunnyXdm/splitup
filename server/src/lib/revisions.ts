import { HTTPException } from 'hono/http-exception';
import {
  db,
  nowIso,
  SNAPSHOT_SQL,
  type ExpenseRevisionRow,
  type ExpenseRow,
  type UserRow,
} from '../db';
import { memberGroupOr404, sharesOf } from './expense';
import { toUser, type Category, type ExpenseShare, type User } from './wire';

export type RevisionAction = ExpenseRevisionRow['action'];

/** An expense's user-facing state at one revision. */
export interface ExpenseSnapshot {
  description: string;
  amountCents: number;
  currency: string;
  date: string;
  category: Category;
  notes: string | null;
  groupId: number | null;
  isPayment: boolean;
  shares: ExpenseShare[];
}

export interface ExpenseRevision {
  revision: number;
  action: RevisionAction;
  actorId: number;
  createdAt: string;
  snapshot: ExpenseSnapshot;
}

/**
 * Appends the expense's CURRENT state as its next revision. Call inside the
 * same transaction as the write it records, after the write.
 */
export function recordRevision(
  expenseId: number,
  action: RevisionAction,
  actorId: number,
  at: string = nowIso(),
): void {
  db.prepare(
    `INSERT INTO expense_revisions (expense_id, revision, action, actor_id, snapshot, created_at)
     SELECT e.id,
       COALESCE((SELECT MAX(r.revision) FROM expense_revisions r WHERE r.expense_id = e.id), 0) + 1,
       ?, ?, ${SNAPSHOT_SQL}, ?
     FROM expenses e WHERE e.id = ?`,
  ).run(action, actorId, at, expenseId);
}

export const toRevision = (r: ExpenseRevisionRow): ExpenseRevision => ({
  revision: r.revision,
  action: r.action,
  actorId: r.actor_id,
  createdAt: r.created_at,
  snapshot: JSON.parse(r.snapshot) as ExpenseSnapshot,
});

export function revisionsOf(expenseId: number): ExpenseRevision[] {
  return db
    .prepare<[number], ExpenseRevisionRow>(
      'SELECT * FROM expense_revisions WHERE expense_id = ? ORDER BY revision DESC',
    )
    .all(expenseId)
    .map(toRevision);
}

export function revisionOf(expenseId: number, revision: number): ExpenseRevision | null {
  const row = db
    .prepare<[number, number], ExpenseRevisionRow>(
      'SELECT * FROM expense_revisions WHERE expense_id = ? AND revision = ?',
    )
    .get(expenseId, revision);
  return row ? toRevision(row) : null;
}

/**
 * Loads an expense — live OR deleted — the caller may see: a member of its
 * (live) group, or for non-group expenses one of its share holders. Read-only:
 * settle-up rows pass too. Anything else → 404, never an existence leak.
 */
export function visibleExpenseOr404(me: UserRow, id: number): ExpenseRow {
  const row = db.prepare<[number], ExpenseRow>('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!row) throw new HTTPException(404, { message: 'not found' });
  if (row.group_id !== null) {
    memberGroupOr404(row.group_id, me.id);
  } else if (!sharesOf(row.id).some((s) => s.user_id === me.id)) {
    throw new HTTPException(404, { message: 'not found' });
  }
  return row;
}

/** Name/avatar for every user id given (unknown ids are skipped). */
export function usersByIds(ids: Iterable<number>): User[] {
  const stmt = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?');
  const out: User[] = [];
  for (const uid of [...new Set(ids)].sort((a, b) => a - b)) {
    const row = stmt.get(uid);
    if (row) out.push(toUser(row));
  }
  return out;
}

/** True when two snapshots describe the same expense state. */
export function sameSnapshot(a: ExpenseSnapshot, b: ExpenseSnapshot): boolean {
  const norm = (s: ExpenseSnapshot) =>
    JSON.stringify([
      s.description,
      s.amountCents,
      s.currency,
      s.date,
      s.category,
      s.notes ?? null,
      s.groupId,
      s.isPayment,
      [...s.shares]
        .sort((x, y) => x.userId - y.userId)
        .map((x) => [x.userId, x.paidCents, x.owedCents]),
    ]);
  return norm(a) === norm(b);
}
