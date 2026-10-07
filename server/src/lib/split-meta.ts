import { splitByWeights, splitEqual } from './recurrence';

/**
 * How an expense was split, as the person entered it — so an edit reopens in
 * the same mode with the same parameters instead of guessing from amounts.
 * Stored in expenses.split_meta (JSON) and returned as `Expense.split`.
 *
 * - equal:   `participants` share equally (remainder cents go to the lowest ids).
 * - unequal: `values` are exact owed amounts in minor units.
 * - percent: `values` are basis points (10000 = 100%).
 * - shares:  `values` are integer share counts.
 *
 * For percent/shares the ORDER of `participants` is the largest-remainder tie
 * order, exactly as the client computed it. Only people with a positive role
 * are listed, and every one of them must hold a share of the expense.
 */
export interface SplitMeta {
  mode: 'equal' | 'unequal' | 'percent' | 'shares';
  participants: number[];
  values?: Record<string, number>;
}

/** Owed cents per participant that a split meta produces for `amountCents`. */
export function owedFromSplitMeta(meta: SplitMeta, amountCents: number): Map<number, number> {
  const values = meta.values ?? {};
  const out = new Map<number, number>();
  switch (meta.mode) {
    case 'equal':
      for (const o of splitEqual(amountCents, [...meta.participants].sort((a, b) => a - b))) {
        out.set(o.userId, o.cents);
      }
      break;
    case 'unequal':
      for (const id of meta.participants) out.set(id, values[String(id)] ?? 0);
      break;
    case 'percent':
    case 'shares':
      for (const o of splitByWeights(
        amountCents,
        meta.participants.map((userId) => ({ userId, weight: values[String(userId)] ?? 0 })),
      )) {
        out.set(o.userId, o.cents);
      }
      break;
  }
  return out;
}

/**
 * Why a split meta doesn't describe these shares, or null when it does. The
 * meta must reproduce every share's owedCents exactly — a stale or forged
 * meta can never disagree with the money that is actually recorded.
 */
export function splitMetaProblem(
  meta: SplitMeta,
  amountCents: number,
  shares: { userId: number; owedCents: number }[],
): string | null {
  const participants = meta.participants;
  if (new Set(participants).size !== participants.length) return 'duplicate split participant';
  const values = meta.values ?? {};
  const keys = Object.keys(values);
  if (meta.mode === 'equal') {
    if (keys.length > 0) return 'an equal split takes no values';
  } else {
    const inSplit = new Set(participants.map(String));
    if (keys.some((k) => !inSplit.has(k))) return 'split values must name participants';
    if (participants.some((id) => !((values[String(id)] ?? 0) > 0))) {
      return 'every split participant needs a positive value';
    }
    if (meta.mode === 'percent' && keys.reduce((s, k) => s + values[k], 0) !== 10_000) {
      return 'percentages must add up to 100';
    }
  }
  const shareIds = new Set(shares.map((s) => s.userId));
  if (participants.some((id) => !shareIds.has(id))) return 'split participants must hold a share';
  const owed = owedFromSplitMeta(meta, amountCents);
  for (const s of shares) {
    if ((owed.get(s.userId) ?? 0) !== s.owedCents) return 'the split does not match the shares';
  }
  return null;
}

/** Stored JSON → SplitMeta, or undefined for missing/corrupt values (never throws). */
export function parseSplitMeta(raw: string | null): SplitMeta | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as SplitMeta;
    if (!v || typeof v !== 'object' || !Array.isArray(v.participants)) return undefined;
    return v;
  } catch {
    return undefined;
  }
}
