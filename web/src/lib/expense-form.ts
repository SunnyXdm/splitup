import {
  centsToInput,
  parsePercentInput,
  parseShareInput,
  todayISO,
} from '@/components/expense/money-input';
import {
  defaultPayerState,
  payerStateFromShares,
  resolvePaid,
  type PayerState,
} from '@/components/expense/payer-state';
import {
  defaultSplitState,
  resolveSplit,
  splitStateFromShares,
  type SplitState,
} from '@/components/expense/split-state';
import { parseAmountToCents } from './money';
import type { Category, Expense, ExpenseInput, ExpenseShare, SyncData, User } from './types';

/**
 * The add-expense form as plain, JSON-serializable data. This is what an
 * autosave or a draft stores, what "Repeat" prefills, and what gets turned
 * into an ExpenseInput on save. Pure — no React.
 */
export interface ExpenseFormValues {
  /** Group scope; null = a 1:1 expense with `friendId`. */
  groupId: number | null;
  /** Counterparty of a non-group expense (null until one is picked). */
  friendId: number | null;
  description: string;
  amountRaw: string;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  category: Category;
  notes: string;
  showNotes: boolean;
  payer: PayerState;
  split: SplitState;
}

export function userById(sync: SyncData, id: number): User {
  return sync.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null };
}

/** Who can take part in a NEW expense with these values, per the current dataset. */
export function participantIdsFor(values: ExpenseFormValues, sync: SyncData): number[] {
  const meId = sync.me.id;
  if (values.groupId !== null) {
    return sync.groups.find((g) => g.id === values.groupId)?.memberIds ?? [];
  }
  return values.friendId !== null ? [meId, values.friendId] : [meId];
}

/** A blank form for a scope (the "Add expense" starting point). */
export function emptyFormValues(
  sync: SyncData,
  scope: { groupId: number | null; friendId?: number | null },
  today: string = todayISO(),
): ExpenseFormValues {
  const meId = sync.me.id;
  const group =
    scope.groupId !== null ? sync.groups.find((g) => g.id === scope.groupId) : undefined;
  const friendId = scope.groupId !== null ? null : (scope.friendId ?? sync.friendIds[0] ?? null);
  const participantIds = group ? group.memberIds : friendId !== null ? [meId, friendId] : [meId];
  return {
    groupId: scope.groupId,
    friendId,
    description: '',
    amountRaw: '',
    currency: group?.currency ?? sync.me.defaultCurrency,
    date: today,
    category: 'general',
    notes: '',
    showNotes: false,
    payer: defaultPayerState(meId),
    split: defaultSplitState(participantIds),
  };
}

/** Edit mode: the stored expense as form values (unequal split = exact stored amounts). */
export function formValuesFromExpense(
  expense: Expense,
  meId: number,
  participantIds: number[],
): ExpenseFormValues {
  return {
    groupId: expense.groupId,
    friendId:
      expense.groupId === null
        ? (expense.shares.find((s) => s.userId !== meId)?.userId ?? null)
        : null,
    description: expense.description,
    amountRaw: centsToInput(expense.amountCents, expense.currency),
    currency: expense.currency,
    date: expense.date,
    category: expense.category,
    notes: expense.notes ?? '',
    showNotes: Boolean(expense.notes),
    payer: payerStateFromShares(expense.shares, meId, expense.currency),
    split: splitStateFromShares(expense.shares, participantIds, expense.currency),
  };
}

/** Stable deep equality for form values (they are plain JSON). */
export function sameFormValues(a: ExpenseFormValues, b: ExpenseFormValues): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)),
        )
      : v,
  );
}

export interface FormErrors {
  description: string | null;
  amount: string | null;
  date: string | null;
  friend: string | null;
  paid: string | null;
  split: string | null;
}

export interface FormCheck {
  amountCents: number | null;
  errors: FormErrors;
  /** The request body, when every rule passes. */
  input: ExpenseInput | null;
}

/** Validate form values against a participant list and build the request body. */
export function checkFormValues(
  values: ExpenseFormValues,
  participants: User[],
  meId: number,
): FormCheck {
  const { currency } = values;
  const amountCents = parseAmountToCents(values.amountRaw, currency);
  const paidRes =
    amountCents !== null ? resolvePaid(values.payer, participants, amountCents, currency) : null;
  const splitRes =
    amountCents !== null ? resolveSplit(values.split, participants, amountCents, currency) : null;
  const errors: FormErrors = {
    description: values.description.trim() === '' ? 'Add a description.' : null,
    amount: amountCents === null ? 'Enter a valid amount.' : null,
    date: values.date === '' ? 'Pick a date.' : null,
    friend:
      values.groupId === null && values.friendId === null
        ? 'Add a friend first — expenses outside a group are shared with a friend.'
        : null,
    paid: paidRes?.error ?? null,
    split: splitRes?.error ?? null,
  };
  if (
    Object.values(errors).some((e) => e !== null) ||
    amountCents === null ||
    !paidRes?.paid ||
    !splitRes?.owed
  ) {
    return { amountCents, errors, input: null };
  }
  const paidMap = new Map(paidRes.paid.map((p) => [p.userId, p.paidCents]));
  const owedMap = new Map(splitRes.owed.map((o) => [o.userId, o.owedCents]));
  let shares: ExpenseShare[];
  if (values.groupId === null && values.friendId !== null) {
    // Non-group: exactly [me, friend], even if one side is all zeros.
    shares = [meId, values.friendId].map((userId) => ({
      userId,
      paidCents: paidMap.get(userId) ?? 0,
      owedCents: owedMap.get(userId) ?? 0,
    }));
  } else {
    const ids = [...new Set([...paidMap.keys(), ...owedMap.keys()])].sort((a, b) => a - b);
    shares = ids
      .map((userId) => ({
        userId,
        paidCents: paidMap.get(userId) ?? 0,
        owedCents: owedMap.get(userId) ?? 0,
      }))
      .filter((s) => s.paidCents > 0 || s.owedCents > 0);
  }
  return {
    amountCents,
    errors,
    input: {
      groupId: values.groupId,
      description: values.description.trim(),
      amountCents,
      currency,
      date: values.date,
      category: values.category,
      notes: values.showNotes && values.notes.trim() !== '' ? values.notes.trim() : null,
      isPayment: false,
      shares,
    },
  };
}

/** The first failing rule of a check, in field order. */
export function firstFormError(check: FormCheck): string | null {
  return Object.values(check.errors).find((e) => e !== null) ?? null;
}

// ---------------------------------------------------------------------------
// Participant revalidation (repeat + drafts)
// ---------------------------------------------------------------------------

const nonZeroMoney = (raw: string | undefined, currency: string) =>
  raw !== undefined && parseShareInput(raw, currency) !== 0;

/** Users that payer/split state gives a non-zero role (paying or owing). */
export function referencedUserIds(values: ExpenseFormValues): number[] {
  const ids = new Set<number>();
  const { payer, split, currency } = values;
  if (payer.mode === 'single') ids.add(payer.payerId);
  else {
    for (const [id, raw] of Object.entries(payer.multiRaw)) {
      if (nonZeroMoney(raw, currency)) ids.add(Number(id));
    }
  }
  switch (split.mode) {
    case 'equal':
      for (const id of split.equalChecked) ids.add(id);
      break;
    case 'unequal':
      for (const [id, raw] of Object.entries(split.unequalRaw)) {
        if (nonZeroMoney(raw, currency)) ids.add(Number(id));
      }
      break;
    case 'percent':
      for (const [id, raw] of Object.entries(split.percentRaw)) {
        if (parsePercentInput(raw) !== 0) ids.add(Number(id));
      }
      break;
    case 'shares':
      for (const [id, n] of Object.entries(split.shareCounts)) if (n > 0) ids.add(Number(id));
      break;
  }
  return [...ids];
}

/** Who the split currently charges (non-zero owed role), in the split's own mode. */
function splitOwers(split: SplitState, currency: string): number[] {
  switch (split.mode) {
    case 'equal':
      return [...split.equalChecked];
    case 'unequal':
      return Object.entries(split.unequalRaw)
        .filter(([, raw]) => nonZeroMoney(raw, currency))
        .map(([id]) => Number(id));
    case 'percent':
      return Object.entries(split.percentRaw)
        .filter(([, raw]) => parsePercentInput(raw) !== 0)
        .map(([id]) => Number(id));
    case 'shares':
      return Object.entries(split.shareCounts)
        .filter(([, n]) => n > 0)
        .map(([id]) => Number(id));
  }
}

const omitKeys = <T>(rec: Record<number, T>, drop: Set<number>): Record<number, T> =>
  Object.fromEntries(Object.entries(rec).filter(([id]) => !drop.has(Number(id))));

export interface Revalidation {
  values: ExpenseFormValues;
  /** What changed and why, for the user ("Removed Asha — no longer in this group"). */
  notes: string[];
  /** Set when the values can't be used at all (e.g. no longer in the group). */
  blocking: string | null;
}

/**
 * Checks form values against the CURRENT dataset and repairs what drifted:
 * departed group members / ex-friends are dropped with a visible note (never
 * silently — their portion would be redistributed), a split that no longer
 * adds up falls back to an equal split among the remaining people, and a group
 * expense is pinned to the group's currency.
 */
export function revalidateFormValues(
  values: ExpenseFormValues,
  sync: SyncData,
  /** Name snapshot for users that may have vanished from the dataset. */
  knownNames: Record<number, string> = {},
): Revalidation {
  const meId = sync.me.id;
  const nameOf = (id: number) =>
    sync.users.find((u) => u.id === id)?.name ?? knownNames[id] ?? 'Someone';
  const notes: string[] = [];

  if (values.groupId === null) {
    if (values.friendId === null || sync.friendIds.includes(values.friendId)) {
      return { values, notes, blocking: null };
    }
    notes.push(`Removed ${nameOf(values.friendId)} — no longer your friend`);
    const fallbackFriend = sync.friendIds[0] ?? null;
    notes.push(
      fallbackFriend === null
        ? 'Add a friend to split this with'
        : 'Choose who to split with — the split was reset to equal',
    );
    return {
      values: {
        ...values,
        friendId: null,
        payer: defaultPayerState(meId),
        split: defaultSplitState([meId]),
      },
      notes,
      blocking: null,
    };
  }

  const group = sync.groups.find((g) => g.id === values.groupId);
  if (!group) {
    return { values, notes, blocking: 'You’re no longer in this group.' };
  }
  let next = values;
  if (next.currency !== group.currency) {
    notes.push(`This group now uses ${group.currency} — check the amount`);
    next = { ...next, currency: group.currency };
  }
  const members = new Set(group.memberIds);
  const departed = referencedUserIds(next).filter((id) => !members.has(id));
  if (departed.length === 0) return { values: next, notes, blocking: null };

  for (const id of departed) notes.push(`Removed ${nameOf(id)} — no longer in this group`);
  const drop = new Set(departed);

  // Paid by: a departed payer can't pay — fall back to "you".
  let payer = next.payer;
  const payerHit =
    payer.mode === 'single'
      ? drop.has(payer.payerId)
      : departed.some((id) => nonZeroMoney(payer.multiRaw[id], next.currency));
  if (payerHit) {
    payer = defaultPayerState(meId);
    notes.push('Paid by reset to you');
  } else if (payer.mode === 'multiple') {
    payer = { ...payer, multiRaw: omitKeys(payer.multiRaw, drop) };
  }

  // Split: equal / shares stay meaningful without them; exact amounts and
  // percentages no longer add up → equal among the remaining people.
  let split = next.split;
  const owersLeft = splitOwers(split, next.currency).filter(
    (id) => !drop.has(id) && members.has(id),
  );
  const splitHit = splitOwers(split, next.currency).some((id) => drop.has(id));
  if (splitHit) {
    const remaining = owersLeft.length > 0 ? owersLeft : group.memberIds;
    if (split.mode === 'shares' && owersLeft.length > 0) {
      split = { ...split, shareCounts: omitKeys(split.shareCounts, drop) };
      notes.push('Shares re-divided between the remaining people');
    } else {
      const wasEqual = split.mode === 'equal';
      split = { ...defaultSplitState(group.memberIds), equalChecked: [...remaining] };
      notes.push(
        wasEqual
          ? 'Split equally between the remaining people'
          : 'Split reset to equal between the remaining people',
      );
    }
  }
  return { values: { ...next, payer, split }, notes, blocking: null };
}
