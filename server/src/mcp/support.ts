import { currencyDigits, formatMoney, parseAmountToCents } from '../../../shared/money';
import type { Expense, Group, SyncData, User } from '../../../shared/types';

/** A failure the assistant should read and act on (shown as a tool error). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

// ---------------------------------------------------------------------- money

/** Every amount a tool returns: exact minor units AND human-readable forms. */
export interface Money {
  currency: string;
  /** Integer minor units (cents/paise); negative where a balance runs against you. */
  minor: number;
  /** Plain decimal string in major units, e.g. "1250.50". */
  amount: string;
  /** Localized currency string, e.g. "₹1,250.50". */
  formatted: string;
}

export function money(minor: number, currency: string): Money {
  const digits = currencyDigits(currency);
  const abs = (Math.abs(minor) / 10 ** digits).toFixed(digits);
  return {
    currency,
    minor,
    amount: minor < 0 ? `-${abs}` : abs,
    formatted: formatMoney(minor, currency),
  };
}

/**
 * "12.50", "1,234.50", 12.5 or "1200/3" → positive minor units in `currency`
 * (the same parser the app's amount fields use, with '.' as the decimal mark).
 */
export function parseAmount(input: string | number, currency: string, what = 'amount'): number {
  const text = typeof input === 'number' ? String(input) : input.trim();
  // A leading currency symbol/code is fine ("₹450", "USD 12"); a minus is not.
  const bare = text.replace(/^[^\d.(-]+/, '');
  const cents = bare.startsWith('-') ? null : parseAmountToCents(bare, currency, 'en');
  if (cents === null) {
    throw new ToolError(
      `${what} "${text}" is not a valid positive ${currency} amount (use e.g. "12.50")`,
    );
  }
  return cents;
}

// --------------------------------------------------------------------- names

/** Lowercase, accents stripped, whitespace collapsed. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type Ref = string | number;

const ME_WORDS = new Set(['me', 'i', 'myself', 'self', 'you', 'yourself']);

const asId = (ref: Ref): number | null => {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0 ? ref : null;
  const m = /^#?(\d{1,12})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
};

/**
 * Exact name (or email) beats a word prefix beats a substring; ambiguity at
 * the winning tier is an error that lists the candidates with their ids.
 */
function fuzzyPick<T extends { id: number }>(
  ref: string,
  items: T[],
  labels: (item: T) => string[],
  describe: (item: T) => string,
  kind: string,
): T | null {
  const q = normalize(ref);
  if (!q) return null;
  const tiers: ((label: string) => boolean)[] = [
    (l) => l === q,
    (l) => l.split(/[\s@._-]+/).some((w) => w.startsWith(q)) || l.startsWith(q),
    (l) => l.includes(q),
  ];
  for (const test of tiers) {
    const hits = items.filter((item) => labels(item).some((l) => test(normalize(l))));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new ToolError(
        `"${ref}" matches several ${kind}s: ${hits
          .slice(0, 8)
          .map(describe)
          .join('; ')}. Pass the id instead.`,
      );
    }
  }
  return null;
}

export const userById = (sync: SyncData, id: number): User | undefined =>
  sync.users.find((u) => u.id === id);

export const nameOf = (sync: SyncData, id: number): string =>
  id === sync.me.id ? `${sync.me.name} (you)` : (userById(sync, id)?.name ?? `user #${id}`);

export function personOut(sync: SyncData, id: number) {
  const u = userById(sync, id);
  return {
    id,
    name: u?.name ?? `user #${id}`,
    ...(id === sync.me.id ? { isMe: true } : {}),
    ...(u?.isGuest ? { guest: true } : {}),
  };
}

const describeUser = (u: User) => `${u.name}${u.email ? ` <${u.email}>` : ''} (id ${u.id})`;

/**
 * A person by id, email, name (fuzzy) or "me". `pool` limits the search
 * (e.g. a group's members); `poolLabel` names it in errors.
 */
export function resolvePerson(
  sync: SyncData,
  ref: Ref,
  pool?: number[],
  poolLabel = 'the people you can see',
): number {
  const allowed = pool ? new Set(pool) : null;
  const inPool = (id: number) => !allowed || allowed.has(id);
  if (typeof ref === 'string' && ME_WORDS.has(normalize(ref))) {
    if (!inPool(sync.me.id)) throw new ToolError(`you are not one of ${poolLabel}`);
    return sync.me.id;
  }
  const id = asId(ref);
  if (id !== null) {
    if (!userById(sync, id) || !inPool(id)) {
      throw new ToolError(`no person with id ${id} among ${poolLabel}`);
    }
    return id;
  }
  const candidates = sync.users.filter((u) => inPool(u.id));
  const hit = fuzzyPick(
    String(ref),
    candidates,
    (u) => [u.name, ...(u.email ? [u.email] : [])],
    describeUser,
    'person',
  );
  if (hit) return hit.id;
  const elsewhere = allowed
    ? fuzzyPick(String(ref), sync.users, (u) => [u.name], describeUser, 'person')
    : null;
  if (elsewhere) throw new ToolError(`${elsewhere.name} is not one of ${poolLabel}`);
  throw new ToolError(`no person matching "${ref}" among ${poolLabel}`);
}

export function resolveGroup(sync: SyncData, ref: Ref): Group {
  const id = asId(ref);
  if (id !== null) {
    const g = sync.groups.find((x) => x.id === id);
    if (!g) throw new ToolError(`no group with id ${id} (or you are not a member)`);
    return g;
  }
  const hit = fuzzyPick(
    String(ref),
    sync.groups,
    (g) => [g.name],
    (g) => `${g.name} (id ${g.id})`,
    'group',
  );
  if (!hit) {
    throw new ToolError(
      `no group matching "${ref}". Your groups: ${
        sync.groups.map((g) => `${g.name} (id ${g.id})`).join(', ') || 'none'
      }`,
    );
  }
  return hit;
}

export function resolveFriend(sync: SyncData, ref: Ref): number {
  return resolvePerson(sync, ref, sync.friendIds, 'your friends');
}

// ------------------------------------------------------------------ expenses

export const groupOut = (sync: SyncData, groupId: number | null) => {
  if (groupId === null) return null;
  const g = sync.groups.find((x) => x.id === groupId);
  return { id: groupId, name: g?.name ?? `group #${groupId}` };
};

/** An expense as the assistant sees it in lists. */
export function expenseOut(sync: SyncData, e: Expense) {
  const me = sync.me.id;
  const mine = e.shares.find((s) => s.userId === me);
  const payers = e.shares.filter((s) => s.paidCents > 0);
  return {
    id: e.id,
    date: e.date,
    description: e.description,
    amount: money(e.amountCents, e.currency),
    category: e.category,
    type: e.isPayment ? 'payment' : 'expense',
    group: groupOut(sync, e.groupId),
    paidBy: payers.map((s) => ({
      ...personOut(sync, s.userId),
      paid: money(s.paidCents, e.currency),
    })),
    ...(e.isPayment
      ? {
          to: e.shares.filter((s) => s.owedCents > 0).map((s) => personOut(sync, s.userId)),
        }
      : {}),
    yourShare: money(mine?.owedCents ?? 0, e.currency),
    /** + = this expense left you owed this much; − = you owe this much. */
    yourNet: money((mine?.paidCents ?? 0) - (mine?.owedCents ?? 0), e.currency),
    ...(e.notes ? { notes: e.notes } : {}),
    ...(e.settlementBatchId != null ? { settlementBatchId: e.settlementBatchId } : {}),
    updatedAt: e.updatedAt,
  };
}

/** "Alex owes you ₹500.00" / "you owe Alex ₹500.00" / "settled". */
export function balanceSentence(
  sync: SyncData,
  otherId: number,
  netCents: number,
  currency: string,
) {
  const who = userById(sync, otherId)?.name ?? `user #${otherId}`;
  if (netCents === 0) return `you and ${who} are settled in ${currency}`;
  const amt = formatMoney(Math.abs(netCents), currency);
  return netCents > 0 ? `${who} owes you ${amt}` : `you owe ${who} ${amt}`;
}

// ---------------------------------------------------------------------- dates

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function monthBounds(day: string, offset = 0): { from: string; to: string } {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
