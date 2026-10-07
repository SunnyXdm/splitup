import { formatMoney, splitByWeights, splitEqual, type OwedSplit } from '@/lib/money';
import type { ExpenseShare, User } from '@/lib/types';
import { centsToInput, formatBp, parsePercentInput, parseShareInput } from './money-input';

/** Pure split-editor state (no React) — shared by the editor, drafts and repeat. */
export type SplitMode = 'equal' | 'unequal' | 'percent' | 'shares';

export interface SplitState {
  mode: SplitMode;
  /** userIds included in an equal split. */
  equalChecked: number[];
  /** Raw amount input per userId (unequal mode). */
  unequalRaw: Record<number, string>;
  /** Raw percent input per userId (percent mode). */
  percentRaw: Record<number, string>;
  /** Integer share count per userId (shares mode). */
  shareCounts: Record<number, number>;
}

export function defaultSplitState(participantIds: number[]): SplitState {
  return {
    mode: 'equal',
    equalChecked: [...participantIds],
    unequalRaw: {},
    percentRaw: {},
    shareCounts: Object.fromEntries(participantIds.map((id) => [id, 1])),
  };
}

/**
 * Rebuild editor state from an existing expense (edit mode): the Unequal tab
 * is preloaded with the stored owedCents so edits start from exact values.
 */
export function splitStateFromShares(
  shares: ExpenseShare[],
  participantIds: number[],
  currency: string,
): SplitState {
  const unequalRaw: Record<number, string> = {};
  const equalChecked: number[] = [];
  for (const id of participantIds) {
    const owed = shares.find((s) => s.userId === id)?.owedCents ?? 0;
    unequalRaw[id] = owed > 0 ? centsToInput(owed, currency) : '';
    if (owed > 0) equalChecked.push(id);
  }
  return {
    mode: 'unequal',
    equalChecked: equalChecked.length > 0 ? equalChecked : [...participantIds],
    unequalRaw,
    percentRaw: {},
    shareCounts: Object.fromEntries(participantIds.map((id) => [id, 1])),
  };
}

export type SplitResolution = { owed: OwedSplit[]; error: null } | { owed: null; error: string };

/** Turn editor state into owed shares, or a human-readable failing rule. */
export function resolveSplit(
  state: SplitState,
  participants: User[],
  amountCents: number,
  currency: string,
): SplitResolution {
  switch (state.mode) {
    case 'equal': {
      const checked = participants
        .map((p) => p.id)
        .filter((id) => state.equalChecked.includes(id))
        .sort((a, b) => a - b);
      if (checked.length === 0) {
        return { owed: null, error: 'Pick at least one person to split with.' };
      }
      return { owed: splitEqual(amountCents, checked), error: null };
    }
    case 'unequal': {
      const owed: OwedSplit[] = [];
      let sum = 0;
      for (const p of participants) {
        const cents = parseShareInput(state.unequalRaw[p.id] ?? '', currency);
        if (cents === null) return { owed: null, error: `Check ${p.name}'s amount.` };
        owed.push({ userId: p.id, owedCents: cents });
        sum += cents;
      }
      if (sum !== amountCents) {
        const diff = amountCents - sum;
        return {
          owed: null,
          error:
            diff > 0
              ? `${formatMoney(diff, currency)} left to split.`
              : `${formatMoney(-diff, currency)} over the total.`,
        };
      }
      return { owed, error: null };
    }
    case 'percent': {
      let sumBp = 0;
      const entries: { userId: number; weight: number }[] = [];
      for (const p of participants) {
        const bp = parsePercentInput(state.percentRaw[p.id] ?? '');
        if (bp === null) return { owed: null, error: `Check ${p.name}'s percentage.` };
        sumBp += bp;
        if (bp > 0) entries.push({ userId: p.id, weight: bp });
      }
      if (sumBp !== 10_000) {
        const diff = 10_000 - sumBp;
        return {
          owed: null,
          error: diff > 0 ? `${formatBp(diff)}% left to assign.` : `${formatBp(-diff)}% over 100.`,
        };
      }
      return { owed: splitByWeights(amountCents, entries), error: null };
    }
    case 'shares': {
      const entries = participants
        .map((p) => ({ userId: p.id, weight: state.shareCounts[p.id] ?? 0 }))
        .filter((e) => e.weight > 0);
      if (entries.length === 0) return { owed: null, error: 'Give at least one share.' };
      return { owed: splitByWeights(amountCents, entries), error: null };
    }
  }
}
