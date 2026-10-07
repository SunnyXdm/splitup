import { HTTPException } from 'hono/http-exception';
import {
  db,
  nowIso,
  type GroupRow,
  type RecurringOccurrenceRow,
  type RecurringRuleRow,
  type UserRow,
} from '../db';
import {
  recurringTemplateSchema,
  todayQuery,
  type ExpenseCreateBody,
  type RecurringTemplate,
} from '../validate';
import { areFriends, groupMemberIds, userName } from './expense';
import { notifyRecurringDue } from './notify-events';
import { dueBetween, resolveShares, type Cadence, type Schedule } from './recurrence';
import type { PendingOccurrence, RecurringRule } from './wire';

/** The server's own calendar date (YYYY-MM-DD in its local timezone). */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DAY_MS = 86_400_000;

/**
 * The caller's "today": a client-supplied local date is trusted only within a
 * day of the server's UTC date (that spans every real timezone), so a client
 * can't make bills due early by claiming it is next month.
 */
export function effectiveToday(clientToday: string | undefined, now: Date = new Date()): string {
  if (clientToday !== undefined) {
    const t = Date.parse(`${clientToday}T00:00:00Z`);
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (!Number.isNaN(t) && Math.abs(t - utcMidnight) <= DAY_MS) return clientToday;
  }
  return localToday(now);
}

/** effectiveToday() from a `?today=YYYY-MM-DD` query value (ignored when malformed). */
export const todayFromQuery = (raw: string | undefined): string =>
  effectiveToday(raw === undefined ? undefined : todayQuery.safeParse(raw).data);

export const scheduleOf =(r: RecurringRuleRow): Schedule => ({
  cadence: r.cadence as Cadence,
  interval: r.interval,
  anchorDate: r.anchor_date,
});

/** Stored template, re-parsed so a hand-edited row can't smuggle in bad shapes. */
export function templateOf(r: RecurringRuleRow): RecurringTemplate {
  return recurringTemplateSchema.parse(JSON.parse(r.template));
}

export const toRecurringRule = (r: RecurringRuleRow): RecurringRule => ({
  id: r.id,
  createdBy: r.created_by,
  groupId: r.group_id,
  friendId: r.friend_id,
  template: templateOf(r),
  cadence: r.cadence as Cadence,
  interval: r.interval,
  anchorDate: r.anchor_date,
  nextDue: r.next_due,
  paused: r.paused === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The idempotency key of an occurrence's expense: adding twice records once. */
export const occurrenceClientKey = (ruleId: number, dueDate: string) => `rec-${ruleId}-${dueDate}`;

/**
 * The expense a template describes for one occurrence. A 1:1 bill always
 * carries both people (even at zero), as every non-group expense does.
 */
export function templateExpenseBody(
  rule: Pick<RecurringRuleRow, 'id' | 'created_by' | 'group_id' | 'friend_id'>,
  template: RecurringTemplate,
  opts: { date: string; amountCents?: number; clientKey?: string },
): ExpenseCreateBody {
  const amountCents = opts.amountCents ?? template.amountCents;
  const keep = rule.friend_id !== null ? [rule.created_by, rule.friend_id] : [];
  let shares;
  try {
    shares = resolveShares(template.split, amountCents, keep);
  } catch {
    throw new HTTPException(400, { message: 'the split does not add up' });
  }
  return {
    groupId: rule.group_id,
    description: template.description,
    amountCents,
    currency: template.currency,
    date: opts.date,
    category: template.category,
    notes: template.notes,
    isPayment: false,
    shares,
    ...(opts.clientKey !== undefined ? { clientKey: opts.clientKey } : {}),
  };
}

const PARTICIPANTS_CHANGED = (message: string) => new HTTPException(409, { message });

/**
 * Add-time revalidation: the people a bill involves may have left the group
 * or stopped being friends since the rule was made. 409 with a sentence the
 * client can show as-is; the user edits the split and adds again.
 */
export function assertParticipantsCurrent(
  me: UserRow,
  rule: Pick<RecurringRuleRow, 'group_id' | 'friend_id'>,
  userIds: number[],
): void {
  if (rule.group_id !== null) {
    const group = db
      .prepare<[number], GroupRow>('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL')
      .get(rule.group_id);
    const members = new Set(group ? groupMemberIds(group.id) : []);
    if (!group || !members.has(me.id)) {
      throw PARTICIPANTS_CHANGED('You’re no longer in this group.');
    }
    const gone = userIds.filter((id) => !members.has(id));
    if (gone.length > 0) {
      const who = gone.map(userName).join(', ');
      const verb = gone.length === 1 ? 'is' : 'are';
      throw PARTICIPANTS_CHANGED(`${who} ${verb} no longer in this group — edit the split first.`);
    }
    return;
  }
  if (rule.friend_id !== null && !areFriends(me.id, rule.friend_id)) {
    throw PARTICIPANTS_CHANGED(`${userName(rule.friend_id)} is no longer your friend.`);
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const insertOccurrence = () =>
  db.prepare(
    `INSERT OR IGNORE INTO recurring_occurrences (rule_id, due_date, status, created_at)
     VALUES (?, ?, 'pending', ?)`,
  );

/**
 * Creates the rule's due occurrences up to `today` and advances next_due.
 * Returns how many NEW inbox items appeared (the UNIQUE pair makes reruns and
 * overlapping runs no-ops).
 */
export function generateForRule(rule: RecurringRuleRow, today: string): number {
  if (rule.paused === 1 || rule.deleted_at !== null || rule.next_due > today) return 0;
  const { dates, nextDue } = dueBetween(scheduleOf(rule), rule.next_due, today);
  const now = nowIso();
  return db.transaction(() => {
    const stmt = insertOccurrence();
    let created = 0;
    for (const d of dates) created += stmt.run(rule.id, d, now).changes;
    db.prepare('UPDATE recurring_rules SET next_due = ? WHERE id = ? AND next_due = ?').run(
      nextDue,
      rule.id,
      rule.next_due,
    );
    return created;
  })();
}

/** Live, unpaused rules that are due — optionally only one creator's. */
function dueRules(today: string, creatorId?: number): RecurringRuleRow[] {
  const sql = `SELECT r.* FROM recurring_rules r
    WHERE r.deleted_at IS NULL AND r.paused = 0 AND r.next_due <= ?
      AND (r.group_id IS NULL OR EXISTS (
        SELECT 1 FROM groups g WHERE g.id = r.group_id AND g.deleted_at IS NULL
      ))
      ${creatorId !== undefined ? 'AND r.created_by = ?' : ''}
    ORDER BY r.id`;
  const stmt = db.prepare<unknown[], RecurringRuleRow>(sql);
  return creatorId !== undefined ? stmt.all(today, creatorId) : stmt.all(today);
}

/** Catch-up for one user's rules (lazy, on sync). */
export function generateForUser(userId: number, today: string): void {
  for (const rule of dueRules(today, userId)) generateForRule(rule, today);
}

const NOTIFIED_KEY = (userId: number) => `recurring_notified_${userId}`;

/**
 * Boot + hourly: catch up every rule, then tell each creator with NEW items
 * once per day ("Rent is due to add"). Lazy sync generation doesn't notify —
 * that user is looking at the inbox already.
 */
export function runRecurringGeneration(today: string = localToday()): void {
  const fresh = new Map<number, string[]>();
  for (const rule of dueRules(today)) {
    try {
      const created = generateForRule(rule, today);
      if (created === 0) continue;
      const list = fresh.get(rule.created_by) ?? [];
      list.push(templateOf(rule).description);
      fresh.set(rule.created_by, list);
    } catch (err) {
      console.error(`recurring: rule ${rule.id} failed`, err);
    }
  }
  for (const [userId, descriptions] of fresh) {
    const last = db
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(NOTIFIED_KEY(userId))?.value;
    if (last === today) continue;
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(NOTIFIED_KEY(userId), today);
    notifyRecurringDue(userId, descriptions);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LIVE_GROUP = `(r.group_id IS NULL OR EXISTS (
  SELECT 1 FROM groups g WHERE g.id = r.group_id AND g.deleted_at IS NULL
))`;

/** Rules I created, plus rules in my live groups (read-only to me). */
export function visibleRules(meId: number): RecurringRuleRow[] {
  return db
    .prepare<[number, number], RecurringRuleRow>(
      `SELECT r.* FROM recurring_rules r
       WHERE r.deleted_at IS NULL AND ${LIVE_GROUP} AND (
         r.created_by = ?
         OR r.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
       )
       ORDER BY r.next_due, r.id`,
    )
    .all(meId, meId);
}

/** My inbox: pending occurrences of my own live rules, oldest first. */
export function pendingFor(meId: number, rules: RecurringRuleRow[]): PendingOccurrence[] {
  const mine = new Map(rules.filter((r) => r.created_by === meId).map((r) => [r.id, r]));
  if (mine.size === 0) return [];
  return db
    .prepare<[number], RecurringOccurrenceRow>(
      `SELECT o.* FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id
       WHERE r.created_by = ? AND o.status = 'pending'
       ORDER BY o.due_date, o.id`,
    )
    .all(meId)
    .flatMap((o) => {
      const rule = mine.get(o.rule_id);
      if (!rule) return [];
      const t = templateOf(rule);
      return [
        {
          id: o.id,
          ruleId: o.rule_id,
          dueDate: o.due_date,
          description: t.description,
          amountCents: t.amountCents,
          currency: t.currency,
          groupId: rule.group_id,
          friendId: rule.friend_id,
        },
      ];
    });
}

const NOT_FOUND = () => new HTTPException(404, { message: 'not found' });

/** A live rule I may see (created it, or a member of its live group); 404 otherwise. */
export function visibleRuleOr404(meId: number, id: number): RecurringRuleRow {
  const rule = visibleRules(meId).find((r) => r.id === id);
  if (!rule) throw NOT_FOUND();
  return rule;
}

/** A rule I may change: only its creator. Co-members see it read-only → 403. */
export function ownRuleOr404(meId: number, id: number): RecurringRuleRow {
  const rule = visibleRuleOr404(meId, id);
  if (rule.created_by !== meId) {
    throw new HTTPException(403, { message: 'only the person who set this up can change it' });
  }
  return rule;
}

export function ruleById(id: number): RecurringRuleRow {
  const rule = db
    .prepare<[number], RecurringRuleRow>('SELECT * FROM recurring_rules WHERE id = ?')
    .get(id);
  if (!rule) throw NOT_FOUND();
  return rule;
}
