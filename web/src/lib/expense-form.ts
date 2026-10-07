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
  splitMetaFromState,
  splitStateFromExpense,
  withSplitMode,
  type SplitState,
} from '@/components/expense/split-state';
import { formatMoney, parseAmountToCents, splitEqual } from './money';
import { displayName, properName } from './names';
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

/**
 * A blank form for a scope (the "Add expense" starting point). Without a
 * group or friend the scope stays unchosen — the form asks for it first and
 * never silently picks someone.
 */
export function emptyFormValues(
  sync: SyncData,
  scope: { groupId: number | null; friendId?: number | null },
  today: string = todayISO(),
): ExpenseFormValues {
  const meId = sync.me.id;
  const group =
    scope.groupId !== null ? sync.groups.find((g) => g.id === scope.groupId) : undefined;
  const friendId = scope.groupId !== null ? null : (scope.friendId ?? null);
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

/**
 * Edit mode: the stored expense as form values — the split as it was entered
 * when the expense carries a description of it, else detected from amounts.
 */
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
    split: splitStateFromExpense(expense, participantIds).state,
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
  /** No group or friend chosen yet. */
  scope: string | null;
  description: string | null;
  amount: string | null;
  date: string | null;
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
    scope:
      values.groupId === null && values.friendId === null ? 'Choose a group or friend.' : null,
    description: values.description.trim() === '' ? 'Add a description.' : null,
    amount: amountCents === null ? 'Enter a valid amount.' : null,
    date: values.date === '' ? 'Pick a date.' : null,
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
  const split = splitMetaFromState(
    values.split,
    participants.map((p) => p.id),
    amountCents,
    shares,
  );
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
      ...(split ? { split } : {}),
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
    notes.push(
      sync.friendIds.length === 0 && sync.groups.length === 0
        ? 'Add a friend to split this with'
        : 'Choose a group or friend — the split was reset to equal',
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

// ---------------------------------------------------------------------------
// Scope changes and the one-line summary
// ---------------------------------------------------------------------------

export type ScopeChoice =
  { kind: 'group'; groupId: number } | { kind: 'friend'; friendId: number };

/** The form's current destination, or null while none is chosen. */
export function scopeChoiceOf(
  values: Pick<ExpenseFormValues, 'groupId' | 'friendId'>,
): ScopeChoice | null {
  if (values.groupId !== null) return { kind: 'group', groupId: values.groupId };
  if (values.friendId !== null) return { kind: 'friend', friendId: values.friendId };
  return null;
}

export interface ScopeChange {
  values: ExpenseFormValues;
  /** Set when the currency changed with it — said out loud, never silent. */
  currencyNotice: string | null;
}

/**
 * Moves an in-progress expense to another group / friend. Description, date,
 * category and notes stay; who paid and the split are re-checked against the
 * new people (a payer who isn't there falls back to you; the split keeps its
 * method over the new people). A group's currency wins — and that change is
 * reported, because the same digits in another currency are not a conversion.
 */
export function applyScope(
  values: ExpenseFormValues,
  choice: ScopeChoice,
  sync: SyncData,
): ScopeChange {
  const meId = sync.me.id;
  const group =
    choice.kind === 'group' ? sync.groups.find((g) => g.id === choice.groupId) : undefined;
  const groupId = choice.kind === 'group' ? choice.groupId : null;
  const friendId = choice.kind === 'friend' ? choice.friendId : null;
  const ids = group ? group.memberIds : friendId !== null ? [meId, friendId] : [meId];
  const currency = group?.currency ?? values.currency;
  const amountCents = parseAmountToCents(values.amountRaw, currency);
  let currencyNotice: string | null = null;
  if (currency !== values.currency) {
    const where = group?.name ?? 'This group';
    currencyNotice =
      amountCents !== null
        ? `${where} uses ${currency}, so the amount is now ${formatMoney(amountCents, currency)} — it wasn’t converted from ${values.currency}.`
        : `${where} uses ${currency}, so amounts are in ${currency} now.`;
  }
  const payer =
    values.payer.mode === 'single' && ids.includes(values.payer.payerId)
      ? values.payer
      : defaultPayerState(meId);
  const split =
    values.split.mode === 'equal'
      ? defaultSplitState(ids)
      : withSplitMode(defaultSplitState(ids), values.split.mode, ids, amountCents, currency);
  return {
    values: { ...values, groupId, friendId, currency, payer, split },
    currencyNotice,
  };
}

/** "In Flat 4B" / "Direct with Darshna Gupta" — never just a name. */
export function scopeTitle(choice: ScopeChoice, sync: SyncData): string {
  if (choice.kind === 'group') {
    const g = sync.groups.find((x) => x.id === choice.groupId);
    return g ? `In ${g.name}` : 'In a group';
  }
  const u = sync.users.find((x) => x.id === choice.friendId);
  return u ? `Direct with ${properName(u.name)}` : 'Direct with a friend';
}

export interface FormSummary {
  /** "Paid by you" */
  paidBy: string;
  /** "Equally between 4 people" */
  split: string;
  /** "₹466.00 each" / "your share ₹300.00" — once the amount is known. */
  detail: string | null;
}

/** The collapsed "Paid by you · Equally between 4 people · ₹466 each" line. */
export function formSummary(
  values: ExpenseFormValues,
  participants: User[],
  meId: number,
  amountCents: number | null,
): FormSummary {
  const { payer, split, currency } = values;
  const name = (id: number) => {
    const u = participants.find((p) => p.id === id);
    if (!u) return 'someone';
    return displayName({ id: u.id, name: properName(u.name) }, meId, { case: 'object' });
  };
  let paidBy: string;
  if (payer.mode === 'single') {
    paidBy = `Paid by ${name(payer.payerId)}`;
  } else {
    const n = Object.values(payer.multiRaw).filter(
      (raw) => (parseShareInput(raw, currency) ?? 0) > 0,
    ).length;
    paidBy = n > 1 ? `Paid by ${n} people` : 'Paid by several people';
  }
  let text: string;
  let detail: string | null = null;
  switch (split.mode) {
    case 'equal': {
      const ids = participants.map((p) => p.id).filter((id) => split.equalChecked.includes(id));
      const others = ids.filter((id) => id !== meId);
      if (ids.length === 0) text = 'Nobody to split with yet';
      else if (ids.length === 1) text = `All owed by ${name(ids[0])}`;
      else if (ids.length === 2 && others.length === 1) {
        text = `Equally between you and ${name(others[0])}`;
      } else text = `Equally between ${ids.length} people`;
      if (amountCents !== null && ids.length > 1) {
        const parts = splitEqual(amountCents, ids);
        const even = parts.every((p) => p.owedCents === parts[0].owedCents);
        const cents = even ? parts[0].owedCents : Math.round(amountCents / ids.length);
        const each = formatMoney(cents, currency);
        detail = `${even ? '' : 'about '}${each} each`;
      }
      break;
    }
    case 'unequal':
      text = 'Unequal amounts';
      break;
    case 'percent':
      text = 'By percentage';
      break;
    case 'shares':
      text = 'By shares';
      break;
  }
  if (detail === null && amountCents !== null && split.mode !== 'equal') {
    const res = resolveSplit(split, participants, amountCents, currency);
    const mine = res.owed?.find((o) => o.userId === meId)?.owedCents;
    if (mine !== undefined) detail = `your share ${formatMoney(mine, currency)}`;
  }
  return { paidBy, split: text, detail };
}
