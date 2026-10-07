import { addDays, endOfMonth, format, isValid, parse, startOfMonth, subMonths } from 'date-fns';
import { CATEGORIES } from './categories';
import { currencyDigits, normalizeAmountText } from './money';
import type { Category, Expense, SyncData } from './types';

/**
 * Expense-history search & filters. Pure and snapshot-memoized: the haystack
 * text of every expense is built once per sync object (like balances.ts), so
 * typing re-runs only a linear scan with cheap substring checks.
 *
 * Filters only ever narrow what a HISTORY LIST shows — balances are always
 * computed from the full dataset elsewhere.
 */

export type RangePreset = 'all' | 'this-month' | 'last-month' | '30d' | 'custom';
export type TypeFilter = 'all' | 'expenses' | 'payments';
/** 'any', 'me', or a user id. */
export type PayerFilter = 'any' | 'me' | number;
/** 'all', 'direct' (non-group), or a group id. */
export type GroupFilter = 'all' | 'direct' | number;

export interface HistoryFilters {
  q: string;
  range: RangePreset;
  /** YYYY-MM-DD, inclusive; only used with range 'custom'. */
  from: string | null;
  to: string | null;
  payer: PayerFilter;
  category: Category | 'all';
  type: TypeFilter;
  group: GroupFilter;
}

export const DEFAULT_FILTERS: HistoryFilters = {
  q: '',
  range: 'all',
  from: null,
  to: null,
  payer: 'any',
  category: 'all',
  type: 'all',
  group: 'all',
};

export const RANGE_LABELS: Record<RangePreset, string> = {
  all: 'All time',
  'this-month': 'This month',
  'last-month': 'Last month',
  '30d': 'Last 30 days',
  custom: 'Custom range',
};

const RANGES = Object.keys(RANGE_LABELS) as RangePreset[];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase, diacritics stripped ("Café" → "cafe"), whitespace collapsed. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- date ranges

function isoDay(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function validDay(s: string | null | undefined): string | null {
  if (!s || !ISO_DAY.test(s)) return null;
  return isValid(parse(s, 'yyyy-MM-dd', new Date())) ? s : null;
}

export interface DayRange {
  /** Inclusive YYYY-MM-DD bounds; null = open-ended. */
  from: string | null;
  to: string | null;
}

/**
 * A preset → inclusive calendar-day bounds in the device's LOCAL time zone
 * (expense dates are local calendar days, so "this month" must be too).
 * A custom range with reversed ends is swapped rather than matching nothing.
 */
export function resolveDateRange(
  range: RangePreset,
  now: Date,
  from: string | null = null,
  to: string | null = null,
): DayRange {
  switch (range) {
    case 'this-month':
      return { from: isoDay(startOfMonth(now)), to: isoDay(endOfMonth(now)) };
    case 'last-month': {
      const last = subMonths(startOfMonth(now), 1);
      return { from: isoDay(last), to: isoDay(endOfMonth(last)) };
    }
    case '30d':
      return { from: isoDay(addDays(now, -29)), to: isoDay(now) };
    case 'custom': {
      const a = validDay(from);
      const b = validDay(to);
      if (a && b && a > b) return { from: b, to: a };
      return { from: a, to: b };
    }
    default:
      return { from: null, to: null };
  }
}

export function inDayRange(date: string, r: DayRange): boolean {
  if (r.from !== null && !(date >= r.from)) return false;
  if (r.to !== null && !(date <= r.to)) return false;
  return true;
}

/** "Oct 1 – Oct 7", "From Oct 1", "Until Oct 7". */
export function formatDayRange(r: DayRange): string {
  const fmt = (s: string) => {
    const d = parse(s, 'yyyy-MM-dd', new Date());
    return format(d, d.getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');
  };
  if (r.from && r.to) return r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`;
  if (r.from) return `From ${fmt(r.from)}`;
  if (r.to) return `Until ${fmt(r.to)}`;
  return RANGE_LABELS.all;
}

// ------------------------------------------------------------ amount matching

/**
 * A query token as a plain decimal ("450", "1,234.50", "₹450", "12,5" in a
 * comma-decimal locale) → { whole, frac }; null when it isn't a number.
 */
export function parseAmountQuery(
  token: string,
  locale?: string,
): { whole: string; frac: string | null } | null {
  // Strip a leading/trailing currency symbol or code ("₹450", "450€", "usd12").
  const stripped = token.replace(/^[^\d.,]+|[^\d.,]+$/g, '');
  if (!/\d/.test(stripped)) return null;
  const canonical = normalizeAmountText(stripped, locale);
  if (canonical === null) return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(canonical);
  if (!m) return null;
  const whole = (m[1] || '0').replace(/^0+(?=\d)/, '');
  const frac = m[2] === undefined || m[2] === '' ? null : m[2];
  return { whole, frac };
}

/**
 * Does the amount (minor units of `currency`) read as the typed number?
 * "450" matches 450.00 and 450.75 (the whole part is what people remember);
 * "450.5" matches 450.50 only. Decimals compare against the currency's own
 * minor digits: "450.00" matches ¥450, "450.5" never does.
 */
export function amountMatches(
  cents: number,
  currency: string,
  query: { whole: string; frac: string | null },
): boolean {
  const digits = currencyDigits(currency);
  const scale = 10 ** digits;
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / scale));
  if (whole !== query.whole) return false;
  if (query.frac === null) return true;
  const frac = digits > 0 ? String(abs % scale).padStart(digits, '0') : '';
  const width = Math.max(frac.length, query.frac.length);
  return frac.padEnd(width, '0') === query.frac.padEnd(width, '0');
}

// ------------------------------------------------------------------- haystack

const haystackCache = new WeakMap<SyncData, WeakMap<Expense, string>>();

/** Normalized searchable text: description, notes, payer names. Per snapshot. */
export function expenseHaystack(sync: SyncData, e: Expense): string {
  let perSync = haystackCache.get(sync);
  if (!perSync) {
    perSync = new WeakMap();
    haystackCache.set(sync, perSync);
  }
  let text = perSync.get(e);
  if (text === undefined) {
    const parts = [String(e.description ?? ''), String(e.notes ?? '')];
    for (const s of e.shares ?? []) {
      if (s.paidCents <= 0) continue;
      if (s.userId === sync.me.id) parts.push('you', sync.me.name);
      else parts.push(userName(sync, s.userId));
    }
    text = normalizeText(parts.join('\n'));
    perSync.set(e, text);
  }
  return text;
}

const userNameCache = new WeakMap<SyncData, Map<number, string>>();

function userName(sync: SyncData, id: number): string {
  let names = userNameCache.get(sync);
  if (!names) {
    names = new Map(sync.users.map((u) => [u.id, u.name]));
    userNameCache.set(sync, names);
  }
  return names.get(id) ?? '';
}

// ------------------------------------------------------------------ predicate

export interface CompiledQuery {
  tokens: {
    text: string;
    amount: { whole: string; frac: string | null } | null;
  }[];
}

export function compileQuery(q: string, locale?: string): CompiledQuery {
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({
      text: normalizeText(raw),
      amount: parseAmountQuery(raw, locale),
    }))
    .filter((t) => t.text !== '');
  return { tokens };
}

/** Every token must match the text OR (if numeric) the amount — AND semantics. */
export function matchesQuery(sync: SyncData, e: Expense, query: CompiledQuery): boolean {
  if (query.tokens.length === 0) return true;
  const hay = expenseHaystack(sync, e);
  for (const t of query.tokens) {
    if (hay.includes(t.text)) continue;
    if (t.amount && amountMatches(e.amountCents, e.currency, t.amount)) continue;
    return false;
  }
  return true;
}

export function hasActiveFilters(f: HistoryFilters): boolean {
  return (
    f.q.trim() !== '' ||
    f.range !== 'all' ||
    f.payer !== 'any' ||
    f.category !== 'all' ||
    f.type !== 'all' ||
    f.group !== 'all'
  );
}

/** Build the filter predicate once (query compiled, range resolved). */
export function buildPredicate(
  sync: SyncData,
  f: HistoryFilters,
  now: Date = new Date(),
  locale?: string,
): (e: Expense) => boolean {
  const query = compileQuery(f.q, locale);
  const range = resolveDateRange(f.range, now, f.from, f.to);
  const payerId = f.payer === 'me' ? sync.me.id : f.payer;
  return (e) => {
    if (f.type === 'expenses' && e.isPayment) return false;
    if (f.type === 'payments' && !e.isPayment) return false;
    if (f.category !== 'all' && (e.isPayment || e.category !== f.category)) return false;
    if (f.group === 'direct' && e.groupId !== null) return false;
    if (typeof f.group === 'number' && e.groupId !== f.group) return false;
    if (payerId !== 'any' && !e.shares.some((s) => s.userId === payerId && s.paidCents > 0)) {
      return false;
    }
    if (!inDayRange(String(e.date ?? ''), range)) return false;
    return matchesQuery(sync, e, query);
  };
}

/** Filter a history list — O(n), order preserved. */
export function filterExpenses(
  sync: SyncData,
  expenses: Expense[],
  f: HistoryFilters,
  now?: Date,
  locale?: string,
): Expense[] {
  if (!hasActiveFilters(f)) return expenses;
  return expenses.filter(buildPredicate(sync, f, now, locale));
}

/** History order: newest date first, then newest created, then highest id. */
export function compareHistory(a: Expense, b: Expense): number {
  // Defensive String(): a malformed row (old cache, server bug) must not throw.
  return (
    String(b.date ?? '').localeCompare(String(a.date ?? '')) ||
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
    b.id - a.id
  );
}

// ---------------------------------------------------------- URL search params

function idParam(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Tolerant: unknown or malformed params fall back to defaults. */
export function filtersFromParams(params: URLSearchParams): HistoryFilters {
  const range = params.get('range') as RangePreset | null;
  const payer = params.get('payer');
  const category = params.get('cat') as Category | null;
  const type = params.get('type') as TypeFilter | null;
  const group = params.get('group');
  return {
    q: params.get('q') ?? '',
    range: range && RANGES.includes(range) ? range : 'all',
    from: validDay(params.get('from')),
    to: validDay(params.get('to')),
    payer: payer === 'me' ? 'me' : (idParam(payer) ?? 'any'),
    category: category && CATEGORIES.includes(category) ? category : 'all',
    type: type === 'expenses' || type === 'payments' ? type : 'all',
    group: group === 'direct' ? 'direct' : (idParam(group) ?? 'all'),
  };
}

const FILTER_KEYS = ['q', 'range', 'from', 'to', 'payer', 'cat', 'type', 'group'] as const;

/**
 * Writes the filters into `base` (other params, e.g. the tab, are kept);
 * defaults are omitted so a clean URL means "no filters".
 */
export function filtersToParams(
  f: HistoryFilters,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of FILTER_KEYS) out.delete(k);
  if (f.q !== '') out.set('q', f.q);
  if (f.range !== 'all') out.set('range', f.range);
  if (f.range === 'custom') {
    if (f.from) out.set('from', f.from);
    if (f.to) out.set('to', f.to);
  }
  if (f.payer !== 'any') out.set('payer', String(f.payer));
  if (f.category !== 'all') out.set('cat', f.category);
  if (f.type !== 'all') out.set('type', f.type);
  if (f.group !== 'all') out.set('group', String(f.group));
  return out;
}
