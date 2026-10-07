import { formatMoney } from '@/lib/money';
import type { ExpenseShare, User } from '@/lib/types';
import { centsToInput, parseShareInput } from './money-input';

/** Pure payer-picker state (no React) — shared by the picker, drafts and repeat. */
export interface PayerState {
  mode: 'single' | 'multiple';
  payerId: number;
  /** Raw input per userId, only meaningful in 'multiple' mode. */
  multiRaw: Record<number, string>;
}

export function defaultPayerState(meId: number): PayerState {
  return { mode: 'single', payerId: meId, multiRaw: {} };
}

/** Rebuild picker state from an existing expense's shares (edit mode). */
export function payerStateFromShares(
  shares: ExpenseShare[],
  meId: number,
  currency: string,
): PayerState {
  const payers = shares.filter((s) => s.paidCents > 0);
  if (payers.length === 1) return { mode: 'single', payerId: payers[0].userId, multiRaw: {} };
  if (payers.length === 0) return defaultPayerState(meId);
  const multiRaw: Record<number, string> = {};
  for (const s of shares) {
    multiRaw[s.userId] = s.paidCents > 0 ? centsToInput(s.paidCents, currency) : '';
  }
  return { mode: 'multiple', payerId: meId, multiRaw };
}

export type PaidResolution =
  { paid: { userId: number; paidCents: number }[]; error: null } | { paid: null; error: string };

/** Turn picker state into paid shares, or a human-readable failing rule. */
export function resolvePaid(
  state: PayerState,
  participants: User[],
  amountCents: number,
  currency: string,
): PaidResolution {
  if (state.mode === 'single') {
    return { paid: [{ userId: state.payerId, paidCents: amountCents }], error: null };
  }
  let sum = 0;
  const paid: { userId: number; paidCents: number }[] = [];
  for (const p of participants) {
    const cents = parseShareInput(state.multiRaw[p.id] ?? '', currency);
    if (cents === null) return { paid: null, error: `Check ${p.name}'s paid amount.` };
    sum += cents;
    paid.push({ userId: p.id, paidCents: cents });
  }
  if (sum !== amountCents) {
    const diff = amountCents - sum;
    return {
      paid: null,
      error:
        diff > 0
          ? `${formatMoney(diff, currency)} left to assign.`
          : `${formatMoney(-diff, currency)} over the total.`,
    };
  }
  return { paid, error: null };
}
