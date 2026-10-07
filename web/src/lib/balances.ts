import { splitByWeights } from './money';
import type { Expense, SyncData } from './types';

export interface NetBalance {
  userId: number;
  /** + means this user is owed money overall */
  netCents: number;
  currency: string;
}

export interface CurrencyAmount {
  currency: string;
  netCents: number;
}

export interface Transfer {
  fromUserId: number;
  toUserId: number;
  cents: number;
  currency: string;
}

/**
 * Pairwise attribution inside one expense: each net debtor (paid < owed) owes
 * each net creditor (paid > owed) proportionally to the creditor's surplus,
 * largest-remainder rounded so every debtor's outgoing transfers sum exactly
 * to their deficit. Deterministic: users processed in ascending userId order.
 */
export function pairwiseForExpense(e: Expense): Transfer[] {
  const creditors: { userId: number; weight: number }[] = [];
  const debtors: { userId: number; deficit: number }[] = [];
  for (const share of e.shares) {
    const net = share.paidCents - share.owedCents;
    if (net > 0) creditors.push({ userId: share.userId, weight: net });
    else if (net < 0) debtors.push({ userId: share.userId, deficit: -net });
  }
  creditors.sort((a, b) => a.userId - b.userId);
  debtors.sort((a, b) => a.userId - b.userId);
  const transfers: Transfer[] = [];
  for (const debtor of debtors) {
    for (const part of splitByWeights(debtor.deficit, creditors)) {
      if (part.owedCents > 0) {
        transfers.push({
          fromUserId: debtor.userId,
          toUserId: part.userId,
          cents: part.owedCents,
          currency: e.currency,
        });
      }
    }
  }
  return transfers;
}

/**
 * Per-member, per-currency nets for one group (+ = owed). Every current member
 * appears for every currency seen in the group's expenses (group currency if
 * none), including zero nets; former participants appear only if nonzero.
 */
export function groupBalances(sync: SyncData, groupId: number): NetBalance[] {
  const derived = derive(sync);
  let cached = derived.balancesByGroup.get(groupId);
  if (!cached) {
    cached = computeGroupBalances(sync, groupId, derived.expensesByGroup.get(groupId) ?? []);
    derived.balancesByGroup.set(groupId, cached);
  }
  return cached;
}

function computeGroupBalances(
  sync: SyncData,
  groupId: number,
  groupExpenses: Expense[],
): NetBalance[] {
  const group = sync.groups.find((g) => g.id === groupId);
  if (!group) return [];
  const nets = new Map<string, Map<number, number>>();
  for (const e of groupExpenses) {
    let byUser = nets.get(e.currency);
    if (!byUser) {
      byUser = new Map();
      nets.set(e.currency, byUser);
    }
    for (const s of e.shares) {
      byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + s.paidCents - s.owedCents);
    }
  }
  if (nets.size === 0) nets.set(group.currency, new Map());
  const roster = new Set(group.memberIds);
  const result: NetBalance[] = [];
  for (const currency of [...nets.keys()].sort()) {
    const byUser = nets.get(currency)!;
    const userIds = [...new Set([...group.memberIds, ...byUser.keys()])].sort((a, b) => a - b);
    for (const userId of userIds) {
      const netCents = byUser.get(userId) ?? 0;
      if (netCents === 0 && !roster.has(userId)) continue;
      result.push({ userId, netCents, currency });
    }
  }
  return result;
}

/**
 * Per-snapshot derived data, computed once per sync object (the query cache
 * hands out a new object on every change, so a WeakMap keyed on it is an exact
 * cache): expenses indexed by group, per-group nets and suggested transfers,
 * and the full transfer list every balance view sums. Without this, each
 * friend row / hero / sheet rebuilt every group's routing from scratch.
 */
interface Derived {
  expensesByGroup: Map<number, Expense[]>;
  balancesByGroup: Map<number, NetBalance[]>;
  settlementsByGroup: Map<number, Transfer[]>;
  allTransfers: Transfer[] | null;
}

const derivedCache = new WeakMap<SyncData, Derived>();

function derive(sync: SyncData): Derived {
  let d = derivedCache.get(sync);
  if (!d) {
    const expensesByGroup = new Map<number, Expense[]>();
    for (const e of sync.expenses) {
      if (e.groupId === null) continue;
      const list = expensesByGroup.get(e.groupId);
      if (list) list.push(e);
      else expensesByGroup.set(e.groupId, [e]);
    }
    d = {
      expensesByGroup,
      balancesByGroup: new Map(),
      settlementsByGroup: new Map(),
      allTransfers: null,
    };
    derivedCache.set(sync, d);
  }
  return d;
}

/** This group's expenses (indexed once per snapshot). */
export function groupExpenses(sync: SyncData, groupId: number): Expense[] {
  return derive(sync).expensesByGroup.get(groupId) ?? [];
}

/** suggestSettlements(groupBalances(sync, groupId)), memoized per snapshot. */
export function groupSettlements(sync: SyncData, groupId: number): Transfer[] {
  const derived = derive(sync);
  let cached = derived.settlementsByGroup.get(groupId);
  if (!cached) {
    cached = suggestSettlements(groupBalances(sync, groupId));
    derived.settlementsByGroup.set(groupId, cached);
  }
  return cached;
}

/**
 * The app shows SIMPLIFIED debts everywhere: within each group, who-owes-whom
 * derives from member NETS via the same deterministic settlement matching the
 * Balances tab suggests — never per-expense attribution. Otherwise settling
 * your whole net through one person (exactly what the app suggests) zeroes
 * your net but leaves phantom pairwise debts against everyone else.
 * Non-group expenses are two-person, so their pairwise ledger IS the net.
 */
function allTransfers(sync: SyncData): Transfer[] {
  const derived = derive(sync);
  if (derived.allTransfers) return derived.allTransfers;
  const transfers: Transfer[] = [];
  for (const g of sync.groups) {
    transfers.push(...groupSettlements(sync, g.id));
  }
  for (const e of sync.expenses) {
    if (e.groupId === null) transfers.push(...pairwiseForExpense(e));
  }
  derived.allTransfers = transfers;
  return transfers;
}

function netVersus(sync: SyncData, includeOther: (otherId: number) => boolean): CurrencyAmount[] {
  const me = sync.me.id;
  const byCurrency = new Map<string, number>();
  for (const t of allTransfers(sync)) {
    if (t.toUserId === me && includeOther(t.fromUserId)) {
      byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + t.cents);
    } else if (t.fromUserId === me && includeOther(t.toUserId)) {
      byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) - t.cents);
    }
  }
  return [...byCurrency.entries()]
    .filter(([, netCents]) => netCents !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, netCents]) => ({ currency, netCents }));
}

/** + means the friend owes me; across group and non-group expenses, per currency. */
export function friendBalance(sync: SyncData, friendId: number): CurrencyAmount[] {
  return netVersus(sync, (otherId) => otherId === friendId);
}

export interface GrossBalance {
  currency: string;
  /** Sum of what each person who owes me owes me (per-person nets, > 0). */
  owedCents: number;
  /** Sum of what I owe each person I owe (per-person nets, as a positive number). */
  owingCents: number;
}

/**
 * Per currency, my per-PERSON balances split into what I'm owed and what I
 * owe. Unlike myTotalBalance, opposite debts don't cancel: owing B 100 while
 * C owes me 100 is a zero net but NOT "settled up". Currencies with no open
 * balance are excluded.
 */
export function myGrossBalances(sync: SyncData): GrossBalance[] {
  const me = sync.me.id;
  const perPerson = new Map<string, number>();
  for (const t of allTransfers(sync)) {
    let other: number;
    let sign: number;
    if (t.toUserId === me) [other, sign] = [t.fromUserId, 1];
    else if (t.fromUserId === me) [other, sign] = [t.toUserId, -1];
    else continue;
    const key = `${t.currency}\u0000${other}`;
    perPerson.set(key, (perPerson.get(key) ?? 0) + sign * t.cents);
  }
  const byCurrency = new Map<string, GrossBalance>();
  for (const [key, net] of perPerson) {
    if (net === 0) continue;
    const currency = key.split('\u0000')[0];
    const entry = byCurrency.get(currency) ?? { currency, owedCents: 0, owingCents: 0 };
    if (net > 0) entry.owedCents += net;
    else entry.owingCents -= net;
    byCurrency.set(currency, entry);
  }
  return [...byCurrency.values()].sort((a, b) =>
    a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0,
  );
}

/** + means the world owes me; per currency, zero entries excluded. */
export function myTotalBalance(sync: SyncData): CurrencyAmount[] {
  return netVersus(sync, () => true);
}

/**
 * Settlement suggestions by a deterministic "two-line sweep": per currency,
 * line creditors up by ascending userId and debtors by ascending userId, then
 * walk both lines with two pointers, each step transferring min(remaining
 * debt, remaining credit). Settles every net to zero in at most
 * creditors + debtors − 1 transfers per currency.
 *
 * Why not greedy largest-first: it is not STABLE. Paying exactly a suggested
 * edge changes the magnitudes, the greedy re-sorts, and the remaining debts
 * can re-route — e.g. nets [+10,+9,+8,−12,−11,−4] leave the same pair owing
 * after the suggested payment. The sweep is provably stable: think of each
 * line as consecutive intervals on [0, total]; an edge is the overlap of a
 * debtor's and a creditor's interval. Paying x on an edge deletes a common
 * x-long segment from BOTH lines, shifting everything after it equally, so
 * every other overlap is unchanged: the new suggestion is exactly the old one
 * minus that payment (fully or partially).
 */
export function suggestSettlements(balances: NetBalance[]): Transfer[] {
  const byCurrency = new Map<string, NetBalance[]>();
  for (const b of balances) {
    const list = byCurrency.get(b.currency);
    if (list) list.push(b);
    else byCurrency.set(b.currency, [b]);
  }
  const transfers: Transfer[] = [];
  for (const currency of [...byCurrency.keys()].sort()) {
    // Merge duplicate rows for the same user (defensive) before lining up.
    const nets = new Map<number, number>();
    for (const b of byCurrency.get(currency)!) {
      nets.set(b.userId, (nets.get(b.userId) ?? 0) + b.netCents);
    }
    const creditors: { userId: number; cents: number }[] = [];
    const debtors: { userId: number; cents: number }[] = [];
    for (const [userId, net] of nets) {
      if (net > 0) creditors.push({ userId, cents: net });
      else if (net < 0) debtors.push({ userId, cents: -net });
    }
    creditors.sort((a, b) => a.userId - b.userId);
    debtors.sort((a, b) => a.userId - b.userId);
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const debtor = debtors[i];
      const creditor = creditors[j];
      const cents = Math.min(debtor.cents, creditor.cents);
      if (cents > 0) {
        transfers.push({ fromUserId: debtor.userId, toUserId: creditor.userId, cents, currency });
      }
      debtor.cents -= cents;
      creditor.cents -= cents;
      if (debtor.cents === 0) i += 1;
      if (creditor.cents === 0) j += 1;
    }
  }
  return transfers;
}
