import { groupExpenses } from './balances';
import { inDayRange, type DayRange } from './search';
import type { Category, Expense, SettlementBatch, SyncData } from './types';

/**
 * Spending summaries ("what did this trip cost me?"). Spending is CONSUMPTION:
 * my share is Σ my owedCents on real expenses — not my net balance, which
 * also moves with who paid. Payments (settle-ups) are never spending; they're
 * reported separately as sent/received. Currencies are never summed together.
 *
 * Sent/received is CASH. A settle-up batch is recorded as several payment
 * rows (one per group slice, plus offsetting counter rows), so its rows are
 * not the cash: when the batch is known, it counts once as its net
 * payer → payee amount, on the batch's date. Legacy unbatched payments count
 * row by row, as before. The group summary deliberately passes no batches:
 * inside one group, the batch's row there IS what settled that group's
 * balance, so a group view shows its allocation, not the cross-group cash.
 */

export interface CategoryTotal {
  category: Category;
  /** My share in this category. */
  cents: number;
}

export interface CurrencySummary {
  currency: string;
  /** Σ amount of non-payment expenses in scope. */
  totalCents: number;
  expenseCount: number;
  /** Σ my owedCents on non-payment expenses — what it cost me. */
  myShareCents: number;
  /** Σ my paidCents on non-payment expenses. */
  myPaidCents: number;
  /** Settle-up payments I made / received. */
  paymentsSentCents: number;
  paymentsReceivedCents: number;
  /** My share by category, largest first; zero categories omitted. */
  categories: CategoryTotal[];
  /** The 5 biggest expenses by whole-bill amount (ties: newest first). */
  top: Expense[];
  /** The 5 expenses where MY share was biggest (ties: newest first). */
  topMine: Expense[];
}

export const TOP_N = 5;

function compareTop(a: Expense, b: Expense): number {
  return (
    b.amountCents - a.amountCents ||
    String(b.date ?? '').localeCompare(String(a.date ?? '')) ||
    b.id - a.id
  );
}

/** Insert into a sorted top-N list — O(N) per item, so O(n) overall. */
function pushTop(
  top: Expense[],
  e: Expense,
  compare: (a: Expense, b: Expense) => number = compareTop,
) {
  if (top.length === TOP_N && compare(e, top[TOP_N - 1]) >= 0) return;
  let i = top.length;
  while (i > 0 && compare(e, top[i - 1]) < 0) i -= 1;
  top.splice(i, 0, e);
  if (top.length > TOP_N) top.pop();
}

interface Acc extends Omit<CurrencySummary, 'categories'> {
  byCategory: Map<Category, number>;
}

/** My owed share of an expense (0 when I'm not in it). */
function myShareOf(e: Expense, meId: number): number {
  return e.shares?.find((s) => s.userId === meId)?.owedCents ?? 0;
}

/**
 * Aggregate `expenses` from `meId`'s point of view, per currency (sorted by
 * code). Rows outside `range` are skipped. A currency appears only if it has
 * at least one expense or payment in scope.
 */
export function summarize(
  expenses: Expense[],
  meId: number,
  range: DayRange = { from: null, to: null },
  batches?: SettlementBatch[],
): CurrencySummary[] {
  const byCurrency = new Map<string, Acc>();
  const accFor = (currency: string): Acc => {
    let acc = byCurrency.get(currency);
    if (!acc) {
      acc = {
        currency,
        totalCents: 0,
        expenseCount: 0,
        myShareCents: 0,
        myPaidCents: 0,
        paymentsSentCents: 0,
        paymentsReceivedCents: 0,
        byCategory: new Map(),
        top: [],
        topMine: [],
      };
      byCurrency.set(currency, acc);
    }
    return acc;
  };
  const batchById = new Map((batches ?? []).map((b) => [b.id, b]));
  const compareMine = (a: Expense, b: Expense) =>
    myShareOf(b, meId) - myShareOf(a, meId) || compareTop(a, b);
  const countedBatches = new Set<number>();
  for (const e of expenses) {
    const batch =
      e.isPayment && e.settlementBatchId != null ? batchById.get(e.settlementBatchId) : undefined;
    if (batch) {
      // Once per settle-up, as the cash that moved — whichever row we meet.
      if (countedBatches.has(batch.id)) continue;
      countedBatches.add(batch.id);
      if (!inDayRange(String(batch.date ?? ''), range)) continue;
      if (batch.payerId !== meId && batch.payeeId !== meId) continue;
      const acc = accFor(batch.currency);
      if (batch.payerId === meId) acc.paymentsSentCents += batch.amountCents;
      else acc.paymentsReceivedCents += batch.amountCents;
      continue;
    }
    if (!inDayRange(String(e.date ?? ''), range)) continue;
    const acc = accFor(e.currency);
    const mine = e.shares?.find((s) => s.userId === meId);
    if (e.isPayment) {
      if (mine) {
        acc.paymentsSentCents += mine.paidCents;
        acc.paymentsReceivedCents += mine.owedCents;
      }
      continue;
    }
    acc.totalCents += e.amountCents;
    acc.expenseCount += 1;
    pushTop(acc.top, e);
    if (mine) {
      acc.myShareCents += mine.owedCents;
      acc.myPaidCents += mine.paidCents;
      if (mine.owedCents > 0) pushTop(acc.topMine, e, compareMine);
      if (mine.owedCents !== 0) {
        acc.byCategory.set(e.category, (acc.byCategory.get(e.category) ?? 0) + mine.owedCents);
      }
    }
  }
  return [...byCurrency.values()]
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map(({ byCategory, ...rest }) => ({
      ...rest,
      categories: [...byCategory.entries()]
        .filter(([, cents]) => cents !== 0)
        .map(([category, cents]) => ({ category, cents }))
        .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    }));
}

// ---------------------------------------------------------------- memoization

const cache = new WeakMap<SyncData, Map<string, CurrencySummary[]>>();

function memo(sync: SyncData, key: string, compute: () => CurrencySummary[]) {
  let perSync = cache.get(sync);
  if (!perSync) {
    perSync = new Map();
    cache.set(sync, perSync);
  }
  let hit = perSync.get(key);
  if (!hit) {
    hit = compute();
    perSync.set(key, hit);
  }
  return hit;
}

/**
 * One group's summary for a day range, memoized per sync snapshot. Payments
 * count as the rows recorded in this group (their allocation to it), not as
 * whole settle-up batches — see the note at the top.
 */
export function groupSummary(sync: SyncData, groupId: number, range: DayRange): CurrencySummary[] {
  return memo(sync, `g:${groupId}:${range.from ?? ''}:${range.to ?? ''}`, () =>
    summarize(groupExpenses(sync, groupId), sync.me.id, range),
  );
}

/** Expenses I'm part of (any share), across groups and 1:1 — per snapshot. */
const involvedCache = new WeakMap<SyncData, Expense[]>();
export function myExpenses(sync: SyncData): Expense[] {
  let list = involvedCache.get(sync);
  if (!list) {
    const me = sync.me.id;
    list = sync.expenses.filter((e) => e.shares?.some((s) => s.userId === me));
    involvedCache.set(sync, list);
  }
  return list;
}

/** Everything I'm part of within a day range, memoized per snapshot. */
export function personalSummary(sync: SyncData, range: DayRange): CurrencySummary[] {
  return memo(sync, `me:${range.from ?? ''}:${range.to ?? ''}`, () =>
    summarize(myExpenses(sync), sync.me.id, range, sync.settlementBatches),
  );
}

/** Earliest YYYY-MM of anything I'm part of (for the month stepper), or null. */
export function firstMonth(sync: SyncData): string | null {
  let min: string | null = null;
  for (const e of myExpenses(sync)) {
    const d = String(e.date ?? '');
    if (/^\d{4}-\d{2}/.test(d) && (min === null || d < min)) min = d;
  }
  return min ? min.slice(0, 7) : null;
}
