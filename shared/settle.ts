import { friendBalance, groupSettlements, pairwiseForExpense } from './balances';
import type { Expense, SyncData } from './types';

/**
 * One slice of a friend balance: a routed edge inside one group, or the direct
 * (non-group) pairwise residue. Sign convention matches friendBalance:
 * + means the friend owes me.
 */
export interface Constituent {
  /** groupId, or null for the direct (non-group) slice. */
  scope: number | null;
  cents: number;
}

/** One payment row to record; always positive, payer/recipient explicit. */
export interface SettleRow {
  groupId: number | null;
  payerId: number;
  recipientId: number;
  amountCents: number;
  /**
   * True when this row's cash direction opposes the settle direction — it
   * offsets an opposing-direction edge so that the cash net equals what
   * actually changed hands.
   */
  counter: boolean;
}

export type SettleDirection = 'i_paid' | 'they_paid';

/**
 * Decomposes my balance with a friend (in one currency) into the per-group
 * routed edges the Friends tab is actually summing, plus the direct residue.
 * Invariant: sum(cents) === the friendBalance entry for that currency.
 *
 * A group slice the pair cannot legally settle inside (the friend is no longer
 * a member, or a legacy edge in a non-group currency) is folded into the
 * direct slice — convergence is preserved, only per-group precision is lost.
 */
export function pairConstituents(
  sync: SyncData,
  friendId: number,
  currency: string,
): Constituent[] {
  const me = sync.me.id;
  const out: Constituent[] = [];
  let direct = 0;

  for (const g of sync.groups) {
    for (const t of groupSettlements(sync, g.id)) {
      if (t.currency !== currency) continue;
      let cents: number;
      if (t.fromUserId === friendId && t.toUserId === me) cents = t.cents;
      else if (t.fromUserId === me && t.toUserId === friendId) cents = -t.cents;
      else continue;
      // Fold only truly unsettleable slices (legacy edge in a non-group
      // currency) into the direct residue. A departed member's edge stays
      // group-scoped: the server accepts it via share history, the group
      // ledger actually settles, and — unlike a direct row — it never turns
      // into a routing-sensitive constant that can flip later.
      if (currency !== g.currency) {
        direct += cents;
      } else {
        out.push({ scope: g.id, cents });
      }
    }
  }

  for (const e of sync.expenses) {
    if (e.groupId !== null || e.currency !== currency) continue;
    for (const t of pairwiseForExpense(e)) {
      if (t.fromUserId === friendId && t.toUserId === me) direct += t.cents;
      else if (t.fromUserId === me && t.toUserId === friendId) direct -= t.cents;
    }
  }

  if (direct !== 0) out.push({ scope: null, cents: direct });
  return out;
}

/**
 * Turns a settle amount into concrete payment rows.
 *
 * dir = +1 when the friend pays me ('they_paid'), −1 when I pay them. Let
 * net = dir · Σ constituents (what a full settle in this direction covers):
 *
 * - net <= 0: the payment doesn't reduce any debt in this direction (goodwill
 *   or contrarian entry) → one plain direct row for the full amount.
 * - amount >= net (full or overpay): one row per same-direction constituent
 *   plus one COUNTER row per opposing constituent (cash-net === net), and any
 *   excess becomes a direct row — a genuine new credit.
 * - amount < net (partial): allocate largest-first over same-direction
 *   constituents only (ties: direct first, then lower groupId). Never emits
 *   counter rows, so every recorded row points in the actual cash direction.
 *
 * All arithmetic is integer cents.
 */
export function apportionSettle(
  constituents: Constituent[],
  amountCents: number,
  direction: SettleDirection,
  meId: number,
  friendId: number,
): SettleRow[] {
  const dir = direction === 'they_paid' ? 1 : -1;
  // Row payer for a constituent follows the constituent's own sign: + means
  // the friend owes me, so the friend pays.
  const row = (scope: number | null, cents: number, counter: boolean): SettleRow => ({
    groupId: scope,
    payerId: cents > 0 ? friendId : meId,
    recipientId: cents > 0 ? meId : friendId,
    amountCents: Math.abs(cents),
    counter,
  });
  // A direct row in the direction of the settle itself.
  const directRow = (amount: number): SettleRow => row(null, dir * amount, false);

  const same = constituents.filter((c) => dir * c.cents > 0);
  const opposing = constituents.filter((c) => dir * c.cents < 0);
  const net = dir * constituents.reduce((sum, c) => sum + c.cents, 0);

  if (net <= 0) return [directRow(amountCents)];

  if (amountCents >= net) {
    // Overpay excess is a direct credit; merge it into an existing
    // same-direction direct slice so the batch never carries two direct rows
    // in one direction (the server rejects that shape).
    const excess = amountCents - net;
    const rows: SettleRow[] = [];
    let excessUsed = false;
    for (const c of same) {
      if (c.scope === null && excess > 0) {
        rows.push(row(null, c.cents + dir * excess, false));
        excessUsed = true;
      } else {
        rows.push(row(c.scope, c.cents, false));
      }
    }
    for (const c of opposing) rows.push(row(c.scope, c.cents, true));
    if (excess > 0 && !excessUsed) rows.push(directRow(excess));
    return rows;
  }

  // Partial: largest-first over same-direction slices; direct slice wins ties,
  // then lower groupId — deterministic and monotone.
  const ordered = [...same].sort((a, b) => {
    const diff = Math.abs(b.cents) - Math.abs(a.cents);
    if (diff !== 0) return diff;
    if (a.scope === null) return -1;
    if (b.scope === null) return 1;
    return a.scope - b.scope;
  });
  const rows: SettleRow[] = [];
  let remaining = amountCents;
  for (const c of ordered) {
    if (remaining === 0) break;
    const take = Math.min(remaining, Math.abs(c.cents));
    rows.push(row(c.scope, dir * take, false));
    remaining -= take;
  }
  return rows;
}

export interface SettlementWatermark {
  /** Max updatedAt over the pair's dependency scope; '' when the scope is empty. */
  watermark: string;
  /** Number of expenses in that scope. */
  watermarkCount: number;
}

/**
 * The freshness fingerprint for a settle with this friend: (max updatedAt,
 * row count) over every VISIBLE expense the pair's routing depends on — all
 * expenses of my groups where the friend is a member or holds any share, plus
 * our direct expenses. The server computes the same pair over the same scope
 * and rejects the batch with 409 on any difference. Exact equality (not
 * ordering) is what makes deletions detectable: a deleted row leaves no
 * client-visible tombstone, but it changes the count. Optimistic temp rows
 * are excluded — callers must not settle while an expense write is in flight.
 */
export function settlementWatermark(sync: SyncData, friendId: number): SettlementWatermark {
  const me = sync.me.id;
  const scopeGroups = new Set<number>();
  for (const g of sync.groups) {
    if (g.memberIds.includes(friendId)) scopeGroups.add(g.id);
  }
  for (const e of sync.expenses) {
    if (e.groupId !== null && e.shares.some((s) => s.userId === friendId)) {
      scopeGroups.add(e.groupId);
    }
  }
  let watermark = '';
  let watermarkCount = 0;
  for (const e of sync.expenses) {
    // Optimistic temp rows (negative ids) don't exist server-side yet; their
    // fake updatedAt / extra count would guarantee a spurious 409.
    if (e.id < 0) continue;
    const relevant =
      e.groupId !== null
        ? scopeGroups.has(e.groupId)
        : e.shares.some((s) => s.userId === me) && e.shares.some((s) => s.userId === friendId);
    if (!relevant) continue;
    watermarkCount++;
    if (e.updatedAt > watermark) watermark = e.updatedAt;
  }
  return { watermark, watermarkCount };
}

/**
 * What a full settle with this person looks like right now: the routed edge
 * inside the group (group mode) or the friend balance (friend mode), in one
 * currency. Null when there is nothing to settle in that currency.
 */
export function currentSuggestion(
  sync: SyncData,
  groupId: number | null,
  counterpartyId: number,
  currency: string,
): { cents: number; direction: SettleDirection } | null {
  const me = sync.me.id;
  if (groupId !== null) {
    const edge = groupSettlements(sync, groupId).find(
      (t) =>
        t.currency === currency &&
        ((t.fromUserId === me && t.toUserId === counterpartyId) ||
          (t.fromUserId === counterpartyId && t.toUserId === me)),
    );
    if (!edge) return null;
    return { cents: edge.cents, direction: edge.toUserId === me ? 'they_paid' : 'i_paid' };
  }
  const entry = friendBalance(sync, counterpartyId).find((b) => b.currency === currency);
  if (!entry || entry.netCents === 0) return null;
  return {
    cents: Math.abs(entry.netCents),
    direction: entry.netCents > 0 ? 'they_paid' : 'i_paid',
  };
}

// ---------------------------------------------------------------------------
// What the settle sheet shows: per-person prefill, netting, the after-balance
// ---------------------------------------------------------------------------

/** What the sheet prefills for one person — from THAT person's balance only. */
export interface SettlePrefill {
  currency: string;
  /** Amount that settles the balance exactly; null when there's nothing to settle. */
  cents: number | null;
  direction: SettleDirection;
}

/**
 * The amount, direction and currency to show for a counterparty. Called on
 * open and again whenever the person changes, so a suggestion can never carry
 * over from someone else. Friend mode prefers `currency` but moves to a
 * currency this person actually has a balance in.
 */
export function settlePrefillFor(
  sync: SyncData,
  groupId: number | null,
  counterpartyId: number,
  currency: string,
): SettlePrefill {
  let target = currency;
  if (groupId === null) {
    const balances = friendBalance(sync, counterpartyId).filter((b) => b.netCents !== 0);
    if (!balances.some((b) => b.currency === currency) && balances.length > 0) {
      const largest = [...balances].sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));
      target = largest[0].currency;
    }
  }
  const s = currentSuggestion(sync, groupId, counterpartyId, target);
  return s
    ? { currency: target, cents: s.cents, direction: s.direction }
    : { currency: target, cents: null, direction: 'i_paid' };
}

/** My balance with this person in the sheet's scope; + means they owe me. */
export function pairBalance(
  sync: SyncData,
  groupId: number | null,
  counterpartyId: number,
  currency: string,
): number {
  const s = currentSuggestion(sync, groupId, counterpartyId, currency);
  if (!s) return 0;
  return s.direction === 'they_paid' ? s.cents : -s.cents;
}

export interface PaymentRow {
  groupId: number | null;
  payerId: number;
  recipientId: number;
  amountCents: number;
}

/**
 * The pair balance once these payment rows are recorded — computed by the
 * same balance code the app shows afterwards (in group mode that includes the
 * group's debt simplification), not by subtracting.
 */
export function balanceAfterPayment(
  sync: SyncData,
  groupId: number | null,
  counterpartyId: number,
  currency: string,
  rows: PaymentRow[],
): number {
  const now = new Date().toISOString();
  const payments: Expense[] = rows.map((r, i) => ({
    id: -1_000_000 - i,
    groupId: r.groupId,
    description: 'Payment',
    amountCents: r.amountCents,
    currency,
    date: now.slice(0, 10),
    category: 'general',
    notes: null,
    isPayment: true,
    shares: [
      { userId: r.payerId, paidCents: r.amountCents, owedCents: 0 },
      { userId: r.recipientId, paidCents: 0, owedCents: r.amountCents },
    ],
    createdBy: sync.me.id,
    createdAt: now,
    updatedAt: now,
  }));
  const after = { ...sync, expenses: [...sync.expenses, ...payments] };
  return pairBalance(after, groupId, counterpartyId, currency);
}

export interface Netting {
  /** What this person owes me across the slices that run my way. */
  owedToYouCents: number;
  /** What I owe them across the slices that run their way. */
  youOweCents: number;
  /** owedToYou − youOwe (+ = they owe me). */
  netCents: number;
}

/**
 * When balances with one person run both ways across groups, the plain
 * arithmetic behind the single number: "₹50,985.46 owed to you − ₹3,070.00
 * you owe = ₹47,915.46". Null when everything runs one way.
 */
export function nettingOf(constituents: Constituent[]): Netting | null {
  let owedToYouCents = 0;
  let youOweCents = 0;
  for (const c of constituents) {
    if (c.cents > 0) owedToYouCents += c.cents;
    else youOweCents -= c.cents;
  }
  if (owedToYouCents === 0 || youOweCents === 0) return null;
  return { owedToYouCents, youOweCents, netCents: owedToYouCents - youOweCents };
}

export interface RemainingBalance {
  /** + they owe me, − I owe them, after recording. */
  afterCents: number;
  /** All square afterwards. */
  settled: boolean;
  /** The payment was bigger than the debt it pays, so the balance now runs the other way. */
  reversed: boolean;
  /** How far past zero the payment went (only when reversed). */
  overpaidCents: number;
}

/** Classifies the after-balance for the sentence under the amount. */
export function remainingBalance(beforeCents: number, afterCents: number): RemainingBalance {
  const reversed = beforeCents !== 0 && afterCents !== 0 && beforeCents > 0 !== afterCents > 0;
  return {
    afterCents,
    settled: afterCents === 0,
    reversed,
    overpaidCents: reversed ? Math.abs(afterCents) : 0,
  };
}
