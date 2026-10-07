import { centsToInput, todayISO } from '@/components/expense/money-input';
import { payerStateFromShares } from '@/components/expense/payer-state';
import {
  defaultSplitState,
  splitStateFromShares,
  type SplitState,
} from '@/components/expense/split-state';
import {
  emptyFormValues,
  revalidateFormValues,
  type ExpenseFormValues,
  type Revalidation,
} from './expense-form';
import { splitEqual } from './money';
import type { Expense, ExpenseShare, SyncData } from './types';

/**
 * Split state for repeating stored shares: stored owedCents are final
 * amounts, so they prefill as an exact (unequal) split — unless they are
 * exactly what an equal split would produce, in which case it stays "equal".
 */
export function repeatSplitState(
  shares: ExpenseShare[],
  participantIds: number[],
  amountCents: number,
  currency: string,
): SplitState {
  const owers = shares
    .filter((s) => s.owedCents > 0)
    .map((s) => s.userId)
    .sort((a, b) => a - b);
  const equal = splitEqual(amountCents, owers);
  const isEqual =
    owers.length > 0 &&
    equal.every((o) => shares.find((s) => s.userId === o.userId)?.owedCents === o.owedCents);
  if (isEqual) return { ...defaultSplitState(participantIds), equalChecked: owers };
  return splitStateFromShares(shares, participantIds, currency);
}

/**
 * "Repeat": a NEW expense's form values prefilled from an existing one — same
 * scope, description, amount, currency, category, notes, payer(s) and split,
 * dated today — revalidated against who is still in the group / a friend.
 */
export function buildRepeatPrefill(
  expense: Expense,
  sync: SyncData,
  today: string = todayISO(),
): Revalidation {
  const meId = sync.me.id;
  if (expense.isPayment) {
    return {
      values: emptyFormValues(sync, { groupId: null }, today),
      notes: [],
      blocking: 'Payments can’t be repeated.',
    };
  }
  const group =
    expense.groupId !== null ? sync.groups.find((g) => g.id === expense.groupId) : undefined;
  if (expense.groupId !== null && !group) {
    return {
      values: emptyFormValues(sync, { groupId: null }, today),
      notes: [],
      blocking: 'You’re no longer in this group.',
    };
  }
  const shareIds = expense.shares.map((s) => s.userId);
  const friendId = expense.groupId === null ? (shareIds.find((id) => id !== meId) ?? null) : null;
  // Everyone the original involved plus today's roster, so the revalidation
  // below sees (and reports) departed people instead of silently losing them.
  const participantIds = group
    ? [...new Set([...group.memberIds, ...shareIds])]
    : friendId !== null
      ? [meId, friendId]
      : [meId];
  const values: ExpenseFormValues = {
    groupId: expense.groupId,
    friendId,
    description: expense.description,
    amountRaw: centsToInput(expense.amountCents, expense.currency),
    currency: expense.currency,
    date: today,
    category: expense.category,
    notes: expense.notes ?? '',
    showNotes: Boolean(expense.notes),
    payer: payerStateFromShares(expense.shares, meId, expense.currency),
    split: repeatSplitState(expense.shares, participantIds, expense.amountCents, expense.currency),
  };
  return revalidateFormValues(values, sync);
}
