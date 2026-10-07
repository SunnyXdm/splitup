/**
 * Pure recurring-bill logic — calendar arithmetic and template → shares. No
 * db and no clock, so it unit-tests cleanly. Dates are plain YYYY-MM-DD
 * strings computed with UTC fields only, so the host timezone never shifts a
 * day.
 */

export const CADENCES = ['weekly', 'monthly', 'yearly'] as const;
export type Cadence = (typeof CADENCES)[number];

/** Most occurrences one catch-up run creates per rule (the most recent ones win). */
export const CATCH_UP_CAP = 24;

export interface Schedule {
  cadence: Cadence;
  /** Every `interval` weeks / months / years (≥ 1). */
  interval: number;
  /** YYYY-MM-DD of occurrence #0; its day-of-month is the target for monthly/yearly. */
  anchorDate: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

function fromUtc(t: number): string {
  const dt = new Date(t);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parts(date);
  return fromUtc(Date.UTC(y, m - 1, d + days));
}

/** Adds whole months, clamping the day to the target month's end (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parts(date);
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12 + 1;
  return `${pad(ty, 4)}-${pad(tm)}-${pad(Math.min(d, daysInMonth(ty, tm)))}`;
}

/**
 * Occurrence #n, always computed from the anchor (never from the previous
 * occurrence), so a clamp is not sticky: Jan 31 → Feb 28 → Mar 31.
 */
export function occurrenceDate(s: Schedule, n: number): string {
  switch (s.cadence) {
    case 'weekly':
      return addDays(s.anchorDate, 7 * s.interval * n);
    case 'monthly':
      return addMonths(s.anchorDate, s.interval * n);
    case 'yearly':
      return addMonths(s.anchorDate, 12 * s.interval * n);
  }
}

/** Upper bound on the walk, so a corrupt row can't spin forever. */
const MAX_STEPS = 100_000;

/** The first occurrence on or after `date` (occurrence #0 when the anchor is later). */
export function firstOnOrAfter(s: Schedule, date: string): string {
  for (let n = 0; n < MAX_STEPS; n++) {
    const d = occurrenceDate(s, n);
    if (d >= date) return d;
  }
  throw new Error('schedule walk did not terminate');
}

/** The first occurrence strictly after `date`. */
export function firstAfter(s: Schedule, date: string): string {
  for (let n = 0; n < MAX_STEPS; n++) {
    const d = occurrenceDate(s, n);
    if (d > date) return d;
  }
  throw new Error('schedule walk did not terminate');
}

export interface DueResult {
  /** Occurrences in [nextDue, today], oldest first, at most `cap` (the most recent). */
  dates: string[];
  /** The first occurrence after today — the rule's new next_due. */
  nextDue: string;
}

/**
 * Catch-up after downtime: every occurrence from `nextDue` up to and including
 * `today`. Capped to the `cap` most recent, so a server that was off for a
 * year does not flood the inbox with weekly items.
 */
export function dueBetween(
  s: Schedule,
  nextDue: string,
  today: string,
  cap: number = CATCH_UP_CAP,
): DueResult {
  const dates: string[] = [];
  for (let n = 0; n < MAX_STEPS; n++) {
    const d = occurrenceDate(s, n);
    if (d < nextDue) continue;
    if (d > today) return { dates: dates.slice(-cap), nextDue: d };
    dates.push(d);
  }
  throw new Error('schedule walk did not terminate');
}

// ---------------------------------------------------------------------------
// Template → shares
// ---------------------------------------------------------------------------

export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares';

/**
 * How a bill is split, stored as intent rather than final amounts so a new
 * amount re-splits correctly: equal stays equal, percentages and share counts
 * keep their ratios, and exact amounts / multiple payers scale
 * proportionally when the amount differs from the template's.
 */
export interface SplitIntent {
  mode: SplitMode;
  /** Everyone the split may charge (equal: exactly who is charged). */
  participants: number[];
  /** exact: owed cents; percent: basis points (sum 10 000); shares: counts. Unused for equal. */
  values?: { userId: number; value: number }[];
  /** Who paid how much of the template amount. */
  payers: { userId: number; cents: number }[];
}

export interface Share {
  userId: number;
  paidCents: number;
  owedCents: number;
}

/** Same algorithm as the web client's splitEqual: remainder cents go to the first ids. */
export function splitEqual(
  amountCents: number,
  userIds: number[],
): { userId: number; cents: number }[] {
  if (userIds.length === 0) return [];
  const base = Math.floor(amountCents / userIds.length);
  const remainder = amountCents - base * userIds.length;
  return userIds.map((userId, i) => ({ userId, cents: base + (i < remainder ? 1 : 0) }));
}

/** Same algorithm as the web client's splitByWeights (largest remainder, ties by order). */
export function splitByWeights(
  amountCents: number,
  entries: { userId: number; weight: number }[],
): { userId: number; cents: number }[] {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (entries.length === 0 || total <= 0) return [];
  const exact = entries.map((e) => (amountCents * e.weight) / total);
  const floors = exact.map(Math.floor);
  let remaining = amountCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = entries.map((e, i) => ({ userId: e.userId, cents: floors[i] }));
  for (const { i } of order) {
    if (remaining <= 0) break;
    result[i].cents += 1;
    remaining -= 1;
  }
  return result;
}

/**
 * Resolve a split intent for `amountCents` into expense shares (sorted by
 * user id, zero rows dropped). `keep` lists users that must appear even with
 * zero amounts (a 1:1 expense always carries both people). Throws on an
 * intent that can't produce a split — callers validate templates up front.
 */
export function resolveShares(
  split: SplitIntent,
  amountCents: number,
  keep: number[] = [],
): Share[] {
  const values = split.values ?? [];
  let owed: { userId: number; cents: number }[];
  switch (split.mode) {
    case 'equal':
      owed = splitEqual(amountCents, [...new Set(split.participants)].sort((a, b) => a - b));
      break;
    case 'exact': {
      const sum = values.reduce((s, v) => s + v.value, 0);
      owed =
        sum === amountCents
          ? values.map((v) => ({ userId: v.userId, cents: v.value }))
          : splitByWeights(
              amountCents,
              values.map((v) => ({ userId: v.userId, weight: v.value })),
            );
      break;
    }
    case 'percent':
    case 'shares':
      owed = splitByWeights(
        amountCents,
        values.filter((v) => v.value > 0).map((v) => ({ userId: v.userId, weight: v.value })),
      );
      break;
  }
  const paidSum = split.payers.reduce((s, p) => s + p.cents, 0);
  const paid =
    paidSum === amountCents
      ? split.payers
      : splitByWeights(
          amountCents,
          split.payers.map((p) => ({ userId: p.userId, weight: p.cents })),
        );
  if (owed.length === 0 || paid.length === 0) throw new Error('split resolves to nothing');
  const byUser = new Map<number, Share>();
  const row = (userId: number) => {
    let s = byUser.get(userId);
    if (!s) {
      s = { userId, paidCents: 0, owedCents: 0 };
      byUser.set(userId, s);
    }
    return s;
  };
  for (const p of paid) row(p.userId).paidCents += p.cents;
  for (const o of owed) row(o.userId).owedCents += o.cents;
  for (const id of keep) row(id);
  const keepSet = new Set(keep);
  return [...byUser.values()]
    .filter((s) => s.paidCents > 0 || s.owedCents > 0 || keepSet.has(s.userId))
    .sort((a, b) => a.userId - b.userId);
}

/** Every user a split intent names in a non-zero role. */
export function intentUserIds(split: SplitIntent): number[] {
  const ids = new Set<number>();
  for (const p of split.payers) if (p.cents > 0) ids.add(p.userId);
  if (split.mode === 'equal') for (const id of split.participants) ids.add(id);
  else for (const v of split.values ?? []) if (v.value > 0) ids.add(v.userId);
  return [...ids].sort((a, b) => a - b);
}
