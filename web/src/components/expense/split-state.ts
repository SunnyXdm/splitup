import { formatMoney, splitByWeights, splitEqual, type OwedSplit } from '@/lib/money';
import type { Expense, ExpenseShare, SplitMeta, User } from '@/lib/types';
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
 * Exact stored amounts as an Unequal split (the legacy fallback when an
 * expense carries no split description and isn't an exact equal split).
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

// ---------------------------------------------------------------------------
// Split descriptions (Expense.split) — mirrors server/src/lib/split-meta.ts
// ---------------------------------------------------------------------------

/** Owed cents per participant that a split description produces. */
export function owedFromSplitMeta(meta: SplitMeta, amountCents: number): Map<number, number> {
  const values = meta.values ?? {};
  const out = new Map<number, number>();
  switch (meta.mode) {
    case 'equal':
      for (const o of splitEqual(amountCents, [...meta.participants].sort((a, b) => a - b))) {
        out.set(o.userId, o.owedCents);
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
        out.set(o.userId, o.owedCents);
      }
      break;
  }
  return out;
}

/** The same consistency rules the server enforces: the description reproduces the shares. */
export function splitMetaMatches(
  meta: SplitMeta,
  amountCents: number,
  shares: Pick<ExpenseShare, 'userId' | 'owedCents'>[],
): boolean {
  const { participants } = meta;
  if (participants.length === 0 || new Set(participants).size !== participants.length) {
    return false;
  }
  const values = meta.values ?? {};
  const keys = Object.keys(values);
  if (meta.mode === 'equal') {
    if (keys.length > 0) return false;
  } else {
    const inSplit = new Set(participants.map(String));
    if (keys.some((k) => !inSplit.has(k))) return false;
    if (participants.some((id) => !((values[String(id)] ?? 0) > 0))) return false;
    if (meta.mode === 'percent' && keys.reduce((s, k) => s + values[k], 0) !== 10_000) {
      return false;
    }
  }
  const shareIds = new Set(shares.map((s) => s.userId));
  if (participants.some((id) => !shareIds.has(id))) return false;
  const owed = owedFromSplitMeta(meta, amountCents);
  return shares.every((s) => (owed.get(s.userId) ?? 0) === s.owedCents);
}

/**
 * The editor state as a split description for the server, or undefined when
 * it can't describe these shares exactly (then the expense is saved without
 * one, and an edit falls back to the stored amounts).
 */
export function splitMetaFromState(
  state: SplitState,
  participantIds: number[],
  amountCents: number,
  shares: Pick<ExpenseShare, 'userId' | 'owedCents'>[],
): SplitMeta | undefined {
  let meta: SplitMeta;
  const positive = (pairs: [number, number][]) => pairs.filter(([, v]) => v > 0);
  switch (state.mode) {
    case 'equal':
      meta = {
        mode: 'equal',
        participants: participantIds
          .filter((id) => state.equalChecked.includes(id))
          .sort((a, b) => a - b),
      };
      break;
    case 'unequal':
    case 'percent':
    case 'shares': {
      const pairs = positive(
        participantIds.map((id): [number, number] => {
          if (state.mode === 'shares') return [id, state.shareCounts[id] ?? 0];
          if (state.mode === 'percent') {
            return [id, parsePercentInput(state.percentRaw[id] ?? '') ?? 0];
          }
          return [id, shares.find((s) => s.userId === id)?.owedCents ?? 0];
        }),
      );
      meta = {
        mode: state.mode,
        participants: pairs.map(([id]) => id),
        values: Object.fromEntries(pairs.map(([id, v]) => [String(id), v])),
      };
      break;
    }
  }
  return splitMetaMatches(meta, amountCents, shares) ? meta : undefined;
}

export interface RestoredSplit {
  state: SplitState;
  /**
   * The expense carries no split description and isn't an exact equal split:
   * it opens as exact amounts, with an explicit "Split equally" action.
   */
  legacy: boolean;
}

/**
 * Edit mode: the split as it was entered. A stored description (that still
 * matches the shares) restores its mode and parameters; without one, shares
 * that are exactly an equal split open as Equal, anything else as the exact
 * stored amounts.
 */
export function splitStateFromExpense(
  expense: Pick<Expense, 'amountCents' | 'currency' | 'shares' | 'split'>,
  participantIds: number[],
): RestoredSplit {
  const { amountCents, currency, shares, split: meta } = expense;
  const base = defaultSplitState(participantIds);
  if (meta && splitMetaMatches(meta, amountCents, shares)) {
    const values = meta.values ?? {};
    const valueOf = (id: number) => values[String(id)] ?? 0;
    switch (meta.mode) {
      case 'equal':
        return { state: { ...base, equalChecked: [...meta.participants] }, legacy: false };
      case 'unequal':
        return {
          state: {
            ...base,
            mode: 'unequal',
            equalChecked: [...meta.participants],
            unequalRaw: Object.fromEntries(
              participantIds.map((id) => [
                id,
                valueOf(id) > 0 ? centsToInput(valueOf(id), currency) : '',
              ]),
            ),
          },
          legacy: false,
        };
      case 'percent':
        return {
          state: {
            ...base,
            mode: 'percent',
            equalChecked: [...meta.participants],
            percentRaw: Object.fromEntries(
              participantIds.map((id) => [id, valueOf(id) > 0 ? formatBp(valueOf(id)) : '']),
            ),
          },
          legacy: false,
        };
      case 'shares':
        return {
          state: {
            ...base,
            mode: 'shares',
            equalChecked: [...meta.participants],
            shareCounts: Object.fromEntries(participantIds.map((id) => [id, valueOf(id)])),
          },
          legacy: false,
        };
    }
  }
  const owers = shares
    .filter((s) => s.owedCents > 0)
    .map((s) => s.userId)
    .sort((a, b) => a - b);
  const equal = splitEqual(amountCents, owers);
  const isEqual =
    owers.length > 0 &&
    equal.every((o) => shares.find((s) => s.userId === o.userId)?.owedCents === o.owedCents);
  if (isEqual) return { state: { ...base, equalChecked: owers }, legacy: false };
  return { state: splitStateFromShares(shares, participantIds, currency), legacy: true };
}

/**
 * Switching split method starts from the even split instead of blanks (so
 * Percent opens at 25% each, Unequal at ₹600 each — never "100% left").
 * Only fills a method whose fields are all still empty.
 */
export function withSplitMode(
  state: SplitState,
  mode: SplitMode,
  participantIds: number[],
  amountCents: number | null,
  currency: string,
): SplitState {
  const included = participantIds.filter((id) => state.equalChecked.includes(id));
  const people = included.length > 0 ? included : participantIds;
  const next: SplitState = { ...state, mode };
  if (mode === 'percent') {
    const empty = participantIds.every(
      (id) => !(parsePercentInput(state.percentRaw[id] ?? '') ?? 0),
    );
    if (empty) {
      const bp = new Map(splitEqual(10_000, people).map((o) => [o.userId, o.owedCents]));
      next.percentRaw = Object.fromEntries(
        participantIds.map((id) => [id, bp.has(id) ? formatBp(bp.get(id)!) : '']),
      );
    }
  } else if (mode === 'unequal' && amountCents !== null) {
    const empty = participantIds.every(
      (id) => !(parseShareInput(state.unequalRaw[id] ?? '', currency) ?? 0),
    );
    if (empty) {
      const owed = new Map(splitEqual(amountCents, people).map((o) => [o.userId, o.owedCents]));
      next.unequalRaw = Object.fromEntries(
        participantIds.map((id) => [id, owed.has(id) ? centsToInput(owed.get(id)!, currency) : '']),
      );
    }
  } else if (mode === 'shares') {
    const empty = participantIds.every((id) => !(state.shareCounts[id] ?? 0));
    if (empty) {
      next.shareCounts = Object.fromEntries(
        participantIds.map((id) => [id, people.includes(id) ? 1 : 0]),
      );
    }
  }
  return next;
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
