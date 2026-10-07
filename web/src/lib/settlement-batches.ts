import type { Expense, SettlementBatch, SettlementMethod } from './types';

export const SETTLEMENT_METHODS: { value: SettlementMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

export const methodLabel = (m: SettlementMethod | null | undefined): string | null =>
  SETTLEMENT_METHODS.find((x) => x.value === m)?.label ?? null;

/**
 * The cash that actually changed hands for a set of payment rows between `a`
 * and `b`: row directions net out (counter rows offset), leaving one payer →
 * payee. Mirrors the server's batch computation.
 */
export function netCash(
  rows: { payerId: number; recipientId: number; amountCents: number }[],
  a: number,
  b: number,
): { payerId: number; payeeId: number; amountCents: number } {
  let aToB = 0;
  for (const r of rows) aToB += r.payerId === a ? r.amountCents : -r.amountCents;
  return aToB >= 0
    ? { payerId: a, payeeId: b, amountCents: aToB }
    : { payerId: b, payeeId: a, amountCents: -aToB };
}

export type HistoryEntry =
  | { kind: 'expense'; key: string; expense: Expense }
  | { kind: 'batch'; key: string; batch: SettlementBatch; rows: Expense[] };

const sortKey = (e: HistoryEntry) =>
  e.kind === 'expense'
    ? {
        date: String(e.expense.date ?? ''),
        createdAt: String(e.expense.createdAt ?? ''),
        id: e.expense.id,
      }
    : {
        date: String(e.batch.date ?? ''),
        createdAt: String(e.batch.createdAt ?? ''),
        id: e.batch.id,
      };

/**
 * Turns history rows into display entries, newest first. With `collapse`,
 * every payment row of a known settle-up batch folds into ONE batch entry (the
 * friend view: one receipt per settle-up). Rows whose batch isn't known (old
 * cache, legacy payments, optimistic rows before the batch arrives) stay
 * individual entries.
 */
export function historyEntries(
  expenses: Expense[],
  batches: SettlementBatch[] | undefined,
  { collapse }: { collapse: boolean },
): HistoryEntry[] {
  const byId = new Map((batches ?? []).map((b) => [b.id, b]));
  const entries: HistoryEntry[] = [];
  const batchEntries = new Map<number, { batch: SettlementBatch; rows: Expense[] }>();
  for (const e of expenses) {
    const batch =
      collapse && e.isPayment && e.settlementBatchId != null
        ? byId.get(e.settlementBatchId)
        : undefined;
    if (!batch) {
      entries.push({ kind: 'expense', key: `e${e.id}`, expense: e });
      continue;
    }
    const existing = batchEntries.get(batch.id);
    if (existing) {
      existing.rows.push(e);
    } else {
      const entry = {
        kind: 'batch' as const,
        key: `b${batch.id}`,
        batch,
        rows: [e],
      };
      batchEntries.set(batch.id, entry);
      entries.push(entry);
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'batch') entry.rows.sort((a, b) => a.id - b.id);
  }
  // Defensive string coercion: a malformed row (old cache) must not crash the list.
  return entries.sort((x, y) => {
    const a = sortKey(x);
    const b = sortKey(y);
    return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  });
}

/** "Split across 2 groups" when a settle-up was recorded in several places; null otherwise. */
export function batchScopeHint(rows: Expense[]): string | null {
  const scopes = new Set(rows.map((r) => r.groupId));
  if (scopes.size < 2) return null;
  const groups = [...scopes].filter((s) => s !== null).length;
  if (!scopes.has(null)) return `Split across ${groups} groups`;
  return `Split across ${groups} ${groups === 1 ? 'group' : 'groups'} and direct`;
}
