import {
  friendBalance,
  groupBalances,
  groupExpenses,
  groupSettlements,
  pairwiseForExpense,
} from './balances';
import { pairConstituents, type Constituent } from './settle';
import type { Expense, SyncData } from './types';

/*
 * "Why do I need to pay this?" — a read-only trace of how a displayed balance
 * is built. Nothing here computes a balance on its own: every number is read
 * back from the same functions the rest of the app shows (pairConstituents,
 * groupBalances, groupSettlements, pairwiseForExpense) and decomposed, so the
 * explanation can never disagree with the headline it explains.
 *
 * Sign convention everywhere: + means the OTHER person owes the focus person
 * (same as friendBalance / Constituent).
 */

/** My balance with a friend in one currency, split by scope. */
export interface FriendExplanation {
  currency: string;
  /** Equals the friendBalance entry; always the sum of `slices`. */
  totalCents: number;
  /** Per group (in sync.groups order), then direct (scope null) last. */
  slices: Constituent[];
}

/** One person's totals inside a group, in one currency. */
export interface MemberTotals {
  userId: number;
  /** Paid towards regular expenses. */
  paidCents: number;
  /** Their share of regular expenses. */
  shareCents: number;
  /** Settle-up payments they made. */
  sentCents: number;
  /** Settle-up payments they received. */
  receivedCents: number;
  /** paid − share + sent − received; equals their groupBalances net. */
  netCents: number;
  /** Still on the group's roster (false = departed member with a balance). */
  current: boolean;
}

/** One person's side of one expense. */
export interface PartyEffect {
  paidCents: number;
  owedCents: number;
  /** paid − owed: how this row moves their group net. */
  netCents: number;
}

export interface LedgerEntry {
  expense: Expense;
  focus: PartyEffect;
  /** Null when the explanation has no counterparty. */
  other: PartyEffect | null;
}

/** One person on a sweep line (creditors or debtors), ascending userId. */
export interface LinePosition {
  userId: number;
  /** |net| */
  cents: number;
  /** Interval on [0, total) the person occupies on their line. */
  start: number;
  end: number;
}

export interface SweepStep {
  /** 0-based order in which the sweep produced this transfer. */
  index: number;
  fromUserId: number;
  toUserId: number;
  cents: number;
  /** Cumulative position on [0, total): this step covers [start, end). */
  start: number;
  end: number;
  /** Involves the focus person (and the counterparty, when one is set). */
  highlighted: boolean;
}

export interface GroupExplanation {
  groupId: number;
  currency: string;
  focusId: number;
  otherId: number | null;
  /** Every person with a net in this group+currency (roster + nonzero departed). */
  members: MemberTotals[];
  /** Every expense/payment in the group in this currency, newest first. */
  ledger: LedgerEntry[];
  /** Total debt being routed (= Σ positive nets = Σ |negative nets|). */
  totalCents: number;
  creditors: LinePosition[];
  debtors: LinePosition[];
  steps: SweepStep[];
  /**
   * Routed amount between focus and other (+ = other pays focus). With no
   * counterparty: the focus person's own net.
   */
  pairCents: number;
}

export type DirectItem =
  | { kind: 'expense'; expense: Expense; cents: number }
  /**
   * A legacy group edge in a currency the group no longer uses: settle.ts
   * folds it into the direct slice, so the explanation lists it here.
   */
  | { kind: 'group'; groupId: number; cents: number };

export interface DirectExplanation {
  currency: string;
  /** Sum of items; equals the direct slice of pairConstituents. */
  totalCents: number;
  items: DirectItem[];
}

/* Per-snapshot memo, keyed like balances.ts: one WeakMap entry per sync. */
const cache = new WeakMap<SyncData, Map<string, unknown>>();

function memo<T>(sync: SyncData, key: string, compute: () => T): T {
  let byKey = cache.get(sync);
  if (!byKey) {
    byKey = new Map();
    cache.set(sync, byKey);
  }
  if (byKey.has(key)) return byKey.get(key) as T;
  const value = compute();
  byKey.set(key, value);
  return value;
}

/** Newest first — the same order the expense history uses. */
function byNewest(a: Expense, b: Expense): number {
  return (
    String(b.date ?? '').localeCompare(String(a.date ?? '')) ||
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
    b.id - a.id
  );
}

/**
 * My nonzero balances with a friend, one entry per currency, each split into
 * the per-scope slices the Friends tab is summing.
 */
export function explainFriend(sync: SyncData, friendId: number): FriendExplanation[] {
  return memo(sync, `friend:${friendId}`, () =>
    friendBalance(sync, friendId).map(({ currency, netCents }) => ({
      currency,
      totalCents: netCents,
      slices: pairConstituents(sync, friendId, currency),
    })),
  );
}

function effectOf(e: Expense, userId: number): PartyEffect {
  let paidCents = 0;
  let owedCents = 0;
  for (const s of e.shares) {
    if (s.userId !== userId) continue;
    paidCents += s.paidCents;
    owedCents += s.owedCents;
  }
  return { paidCents, owedCents, netCents: paidCents - owedCents };
}

/** Lays people out on consecutive intervals of [0, total), ascending userId. */
function line(entries: { userId: number; cents: number }[]): LinePosition[] {
  let pos = 0;
  return [...entries]
    .sort((a, b) => a.userId - b.userId)
    .map(({ userId, cents }) => {
      const start = pos;
      pos += cents;
      return { userId, cents, start, end: pos };
    });
}

/**
 * Everything behind one group's balance between `focusId` and `otherId` (or
 * behind focusId's own net when otherId is null), in one currency: the ledger,
 * the per-member totals and nets, and the sweep that routed those nets.
 */
export function explainGroup(
  sync: SyncData,
  groupId: number,
  currency: string,
  focusId: number,
  otherId: number | null,
): GroupExplanation {
  return memo(sync, `group:${groupId}:${currency}:${focusId}:${otherId ?? ''}`, () => {
    const group = sync.groups.find((g) => g.id === groupId);
    const roster = new Set(group?.memberIds ?? []);
    const expenses = groupExpenses(sync, groupId)
      .filter((e) => e.currency === currency)
      .sort(byNewest);

    // Per-member totals, split into expenses vs settle-up payments.
    const totals = new Map<number, MemberTotals>();
    const totalsOf = (userId: number): MemberTotals => {
      let t = totals.get(userId);
      if (!t) {
        t = {
          userId,
          paidCents: 0,
          shareCents: 0,
          sentCents: 0,
          receivedCents: 0,
          netCents: 0,
          current: roster.has(userId),
        };
        totals.set(userId, t);
      }
      return t;
    };
    for (const e of expenses) {
      for (const s of e.shares) {
        const t = totalsOf(s.userId);
        if (e.isPayment) {
          t.sentCents += s.paidCents;
          t.receivedCents += s.owedCents;
        } else {
          t.paidCents += s.paidCents;
          t.shareCents += s.owedCents;
        }
        t.netCents += s.paidCents - s.owedCents;
      }
    }
    // Same membership as the Balances tab: whoever groupBalances lists.
    const members = groupBalances(sync, groupId)
      .filter((b) => b.currency === currency)
      .map((b) => totalsOf(b.userId));

    const ledger: LedgerEntry[] = expenses.map((expense) => ({
      expense,
      focus: effectOf(expense, focusId),
      other: otherId === null ? null : effectOf(expense, otherId),
    }));

    const creditors = line(
      members.filter((m) => m.netCents > 0).map((m) => ({ userId: m.userId, cents: m.netCents })),
    );
    const debtors = line(
      members.filter((m) => m.netCents < 0).map((m) => ({ userId: m.userId, cents: -m.netCents })),
    );
    const totalCents = creditors.reduce((sum, c) => sum + c.cents, 0);

    // The sweep's transfers come straight from groupSettlements (what the app
    // shows); the sweep emits them in order, so positions are a running sum.
    const involves = (fromUserId: number, toUserId: number) =>
      otherId === null
        ? fromUserId === focusId || toUserId === focusId
        : (fromUserId === focusId && toUserId === otherId) ||
          (fromUserId === otherId && toUserId === focusId);
    let pos = 0;
    const steps: SweepStep[] = groupSettlements(sync, groupId)
      .filter((t) => t.currency === currency)
      .map((t, index) => {
        const start = pos;
        pos += t.cents;
        return {
          index,
          fromUserId: t.fromUserId,
          toUserId: t.toUserId,
          cents: t.cents,
          start,
          end: pos,
          highlighted: involves(t.fromUserId, t.toUserId),
        };
      });

    let pairCents = 0;
    if (otherId === null) {
      pairCents = totals.get(focusId)?.netCents ?? 0;
    } else {
      for (const s of steps) {
        if (s.fromUserId === otherId && s.toUserId === focusId) pairCents += s.cents;
        else if (s.fromUserId === focusId && s.toUserId === otherId) pairCents -= s.cents;
      }
    }

    return {
      groupId,
      currency,
      focusId,
      otherId,
      members,
      ledger,
      totalCents,
      creditors,
      debtors,
      steps,
      pairCents,
    };
  });
}

/**
 * The direct (non-group) slice of my balance with a friend: each direct
 * expense/payment between us with its signed effect, plus any legacy group
 * edges settle.ts folds into this slice.
 */
export function explainDirect(
  sync: SyncData,
  friendId: number,
  currency: string,
): DirectExplanation {
  return memo(sync, `direct:${friendId}:${currency}`, () => {
    const me = sync.me.id;
    const items: DirectItem[] = [];

    for (const g of sync.groups) {
      if (g.currency === currency) continue;
      let cents = 0;
      for (const t of groupSettlements(sync, g.id)) {
        if (t.currency !== currency) continue;
        if (t.fromUserId === friendId && t.toUserId === me) cents += t.cents;
        else if (t.fromUserId === me && t.toUserId === friendId) cents -= t.cents;
      }
      if (cents !== 0) items.push({ kind: 'group', groupId: g.id, cents });
    }

    const direct = sync.expenses
      .filter(
        (e) =>
          e.groupId === null &&
          e.currency === currency &&
          e.shares.some((s) => s.userId === me) &&
          e.shares.some((s) => s.userId === friendId),
      )
      .sort(byNewest);
    for (const expense of direct) {
      let cents = 0;
      for (const t of pairwiseForExpense(expense)) {
        if (t.fromUserId === friendId && t.toUserId === me) cents += t.cents;
        else if (t.fromUserId === me && t.toUserId === friendId) cents -= t.cents;
      }
      items.push({ kind: 'expense', expense, cents });
    }

    return {
      currency,
      totalCents: items.reduce((sum, i) => sum + i.cents, 0),
      items,
    };
  });
}
