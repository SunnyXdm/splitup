import type { ActivityItem, Expense, SettlementBatch } from './types';

/**
 * Where a history list is shown. It decides which facts a row may claim:
 * a person-to-person balance can only be attributed to one expense when that
 * expense is just the two of you (a direct 1:1 bill).
 */
export type HistoryScope =
  { kind: 'all' } | { kind: 'group'; groupId: number } | { kind: 'friend'; friendId: number };

/** My part in one expense. */
export interface MyStake {
  paidCents: number;
  shareCents: number;
  /** paid − share: + means the expense moves money towards me. */
  netCents: number;
  /** I paid something or owe a share. */
  involved: boolean;
}

export function myStake(e: Expense, meId: number): MyStake {
  const s = e.shares.find((x) => x.userId === meId);
  const paidCents = s?.paidCents ?? 0;
  const shareCents = s?.owedCents ?? 0;
  return {
    paidCents,
    shareCents,
    netCents: paidCents - shareCents,
    involved: paidCents > 0 || shareCents > 0,
  };
}

/**
 * The right-hand fact of an expense row:
 * - net: "you lent / you borrowed" — my whole-expense effect. Shown in group
 *   and global lists, and on a friend page only for 1:1 bills, where it IS
 *   the effect on that friend's balance.
 * - share: "your share" — on a friend page for a shared (group or 3+ person)
 *   bill, where my net isn't what this friend owes me (ASTRA #1).
 * - even: I took part but my paid equals my share ("no balance change").
 * - none: I'm not in this expense.
 */
export type RowFact =
  | { kind: 'net'; cents: number }
  | { kind: 'share'; cents: number }
  | { kind: 'even' }
  | { kind: 'none' };

/** A bill between exactly me and one other person, outside any group. */
export function isOneToOne(e: Expense, meId: number, otherId?: number): boolean {
  if (e.groupId !== null) return false;
  const people = e.shares.filter((s) => s.paidCents > 0 || s.owedCents > 0).map((s) => s.userId);
  if (people.length !== 2 || !people.includes(meId)) return false;
  return otherId === undefined || people.includes(otherId);
}

export function expenseRowFact(e: Expense, meId: number, scope: HistoryScope): RowFact {
  const stake = myStake(e, meId);
  if (!stake.involved) return { kind: 'none' };
  if (scope.kind === 'friend' && !isOneToOne(e, meId, scope.friendId)) {
    return stake.shareCents > 0 ? { kind: 'share', cents: stake.shareCents } : { kind: 'none' };
  }
  if (stake.netCents === 0) return { kind: 'even' };
  return { kind: 'net', cents: stake.netCents };
}

/** "You paid", "Darshna paid", "2 people paid" — who paid the bill. */
export function payersLabel(e: Expense, nameOf: (id: number) => string): string {
  const payers = e.shares.filter((s) => s.paidCents > 0);
  if (payers.length === 0) return 'Nobody paid';
  if (payers.length === 1) return `${nameOf(payers[0].userId)} paid`;
  return `${payers.length} people paid`;
}

/* ------------------------------------------------------- batch in context */

/**
 * How one settle-up reads in a list that shows only some of its rows (a
 * group page, a filtered search). Never the full batch cash in a context that
 * only holds part of it (ASTRA, overriding audit C6):
 * - whole: every row is here → the cash that moved, once.
 * - partial: "₹5,000 applied here · part of ₹8,380 payment".
 * - offset: the rows here run against the cash ("₹3,070 offset here").
 */
export interface BatchInContext {
  /** What this context shows as the amount: the cash, or the part applied here. */
  cents: number;
  partial: boolean;
  /** The part here runs against the cash direction (an offsetting entry). */
  offset: boolean;
  /** The whole payment's cash. */
  totalCents: number;
}

const rowParties = (r: Expense) => ({
  payerId: r.shares.find((s) => s.paidCents > 0)?.userId ?? 0,
  recipientId: r.shares.find((s) => s.owedCents > 0)?.userId ?? 0,
  amountCents: r.amountCents,
});

export function batchInContext(
  batch: SettlementBatch,
  shownRows: Expense[],
  allRows: Expense[],
): BatchInContext {
  const shownIds = new Set(shownRows.map((r) => r.id));
  const whole = allRows.length === 0 || allRows.every((r) => shownIds.has(r.id));
  if (whole) {
    return {
      cents: batch.amountCents,
      partial: false,
      offset: false,
      totalCents: batch.amountCents,
    };
  }
  let towardsPayee = 0;
  for (const r of shownRows.map(rowParties)) {
    towardsPayee += r.payerId === batch.payerId ? r.amountCents : -r.amountCents;
  }
  return {
    cents: Math.abs(towardsPayee),
    partial: true,
    offset: towardsPayee < 0,
    totalCents: batch.amountCents,
  };
}

/* ---------------------------------------------------------------- activity */

export type ActivityEvent =
  | { kind: 'item'; key: string; item: ActivityItem; createdAt: string }
  | {
      kind: 'batch';
      key: string;
      batch: SettlementBatch;
      /** The payment rows' activity items, oldest first. */
      items: ActivityItem[];
      createdAt: string;
    };

/**
 * Activity rows as events: the server writes one `payment_added` per payment
 * row, so one settle-up across 2 groups arrives as 2+ items. Items whose
 * payment row belongs to a known batch fold into one batch event (placed
 * where its newest item was); everything else stays one event per item.
 * Newest first.
 */
export function activityEvents(
  items: ActivityItem[],
  expensesById: Map<number, Expense>,
  batchesById: Map<number, SettlementBatch>,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const byBatch = new Map<number, Extract<ActivityEvent, { kind: 'batch' }>>();
  for (const item of items) {
    const row =
      item.type === 'payment_added' && item.expenseId !== null
        ? expensesById.get(item.expenseId)
        : undefined;
    const batch =
      row?.settlementBatchId != null ? batchesById.get(row.settlementBatchId) : undefined;
    if (!batch) {
      events.push({ kind: 'item', key: `a${item.id}`, item, createdAt: item.createdAt });
      continue;
    }
    const existing = byBatch.get(batch.id);
    if (existing) {
      existing.items.push(item);
      if (item.createdAt > existing.createdAt) existing.createdAt = item.createdAt;
    } else {
      const event = {
        kind: 'batch' as const,
        key: `b${batch.id}`,
        batch,
        items: [item],
        createdAt: item.createdAt,
      };
      byBatch.set(batch.id, event);
      events.push(event);
    }
  }
  for (const e of byBatch.values()) e.items.sort((a, b) => a.id - b.id);
  return events.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      (b.kind === 'item' ? b.item.id : b.batch.id) - (a.kind === 'item' ? a.item.id : a.batch.id),
  );
}

/** "across 2 groups", "across 1 group and direct" — null for a single-scope payment. */
export function acrossLabel(rows: Expense[]): string | null {
  const scopes = new Set(rows.map((r) => r.groupId));
  if (scopes.size < 2) return null;
  const groups = [...scopes].filter((s) => s !== null).length;
  if (!scopes.has(null)) return `across ${groups} groups`;
  return `across ${groups} ${groups === 1 ? 'group' : 'groups'} and direct`;
}
