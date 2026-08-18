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
  const group = sync.groups.find((g) => g.id === groupId);
  if (!group) return [];
  const nets = new Map<string, Map<number, number>>();
  for (const e of sync.expenses) {
    if (e.groupId !== groupId) continue;
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
 * The app shows SIMPLIFIED debts everywhere: within each group, who-owes-whom
 * derives from member NETS via the same deterministic settlement matching the
 * Balances tab suggests — never per-expense attribution. Otherwise settling
 * your whole net through one person (exactly what the app suggests) zeroes
 * your net but leaves phantom pairwise debts against everyone else.
 * Non-group expenses are two-person, so their pairwise ledger IS the net.
 */
function allTransfers(sync: SyncData): Transfer[] {
  const transfers: Transfer[] = [];
  for (const g of sync.groups) {
    transfers.push(...suggestSettlements(groupBalances(sync, g.id)));
  }
  for (const e of sync.expenses) {
    if (e.groupId === null) transfers.push(...pairwiseForExpense(e));
  }
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

/** + means the world owes me; per currency, zero entries excluded. */
export function myTotalBalance(sync: SyncData): CurrencyAmount[] {
  return netVersus(sync, () => true);
}

function takeLargest(entries: { userId: number; cents: number }[]): { userId: number; cents: number } {
  let best = entries[0];
  for (const entry of entries) {
    if (entry.cents > best.cents || (entry.cents === best.cents && entry.userId < best.userId)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Greedy settlement suggestions: per currency, repeatedly match the largest
 * debtor with the largest creditor (ties broken by lower userId) and transfer
 * min(debt, credit). Settles every net to zero in at most participants−1
 * transfers per currency — few, deterministic, but not guaranteed minimal.
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
    const creditors: { userId: number; cents: number }[] = [];
    const debtors: { userId: number; cents: number }[] = [];
    for (const b of byCurrency.get(currency)!) {
      if (b.netCents > 0) creditors.push({ userId: b.userId, cents: b.netCents });
      else if (b.netCents < 0) debtors.push({ userId: b.userId, cents: -b.netCents });
    }
    while (creditors.length > 0 && debtors.length > 0) {
      const debtor = takeLargest(debtors);
      const creditor = takeLargest(creditors);
      const cents = Math.min(debtor.cents, creditor.cents);
      transfers.push({ fromUserId: debtor.userId, toUserId: creditor.userId, cents, currency });
      debtor.cents -= cents;
      creditor.cents -= cents;
      if (debtor.cents === 0) debtors.splice(debtors.indexOf(debtor), 1);
      if (creditor.cents === 0) creditors.splice(creditors.indexOf(creditor), 1);
    }
  }
  return transfers;
}
