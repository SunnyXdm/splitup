import { centsToInput, formatBp, parsePercentInput } from '@/components/expense/money-input';
import { defaultPayerState, type PayerState } from '@/components/expense/payer-state';
import { defaultSplitState, type SplitState } from '@/components/expense/split-state';
import { formatDateSafe } from './dates';
import { revalidateFormValues, type ExpenseFormValues, type Revalidation } from './expense-form';
import { splitByWeights } from './money';
import type {
  Cadence,
  ExpenseInput,
  PendingOccurrence,
  RecurringRule,
  RecurringSplit,
  RecurringTemplate,
  SyncData,
} from './types';

/**
 * Recurring bills on the client — pure. Calendar math mirrors the server's
 * lib/recurrence.ts (UTC fields only, day clamped to the month's end, every
 * occurrence computed from the anchor), so "next on …" previews agree with
 * what the server will generate.
 */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12 + 1;
  return `${pad(ty, 4)}-${pad(tm)}-${pad(Math.min(d, daysInMonth(ty, tm)))}`;
}

export function occurrenceDate(
  s: { cadence: Cadence; interval: number; anchorDate: string },
  n: number,
): string {
  switch (s.cadence) {
    case 'weekly':
      return addDays(s.anchorDate, 7 * s.interval * n);
    case 'monthly':
      return addMonths(s.anchorDate, s.interval * n);
    case 'yearly':
      return addMonths(s.anchorDate, 12 * s.interval * n);
  }
}

export const CADENCE_OPTIONS: { value: Cadence | 'none'; label: string }[] = [
  { value: 'none', label: 'Doesn’t repeat' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

const UNIT: Record<Cadence, string> = { weekly: 'week', monthly: 'month', yearly: 'year' };

/** "Monthly" / "Every 2 weeks". */
export function cadenceLabel(cadence: Cadence, interval = 1): string {
  if (interval === 1) return CADENCE_OPTIONS.find((o) => o.value === cadence)!.label;
  return `Every ${interval} ${UNIT[cadence]}s`;
}

/** "Oct 1" (adds the year when it isn't `today`'s). */
export function shortDate(date: string, today: string): string {
  return formatDateSafe(date, date.slice(0, 4) === today.slice(0, 4) ? 'MMM d' : 'MMM d, yyyy');
}

/**
 * What saving the add-expense form with "Repeat" does: a date up to today
 * records the expense now and the rule starts next period; a future date only
 * sets the rule up, its first occurrence being that date.
 */
export function repeatPlan(
  date: string,
  cadence: Cadence,
  today: string,
): { addFirst: boolean; firstDue: string } {
  if (date > today) return { addFirst: false, firstDue: date };
  return {
    addFirst: true,
    firstDue: occurrenceDate({ cadence, interval: 1, anchorDate: date }, 1),
  };
}

// ---------------------------------------------------------------------------
// Form values ⇄ template
// ---------------------------------------------------------------------------

/**
 * A rule template from the form: the split keeps the editor's MODE (equal /
 * exact / percent / shares) rather than its resolved cents, in participant
 * order so the server's rounding matches the editor's.
 */
export function templateFromForm(
  values: ExpenseFormValues,
  input: ExpenseInput,
  participantIds: number[],
): RecurringTemplate {
  const { split } = values;
  const payers = input.shares
    .filter((s) => s.paidCents > 0)
    .map((s) => ({ userId: s.userId, cents: s.paidCents }));
  let intent: RecurringSplit;
  switch (split.mode) {
    case 'equal':
      intent = {
        mode: 'equal',
        participants: participantIds
          .filter((id) => split.equalChecked.includes(id))
          .sort((a, b) => a - b),
        payers,
      };
      break;
    case 'unequal': {
      const owed = new Map(input.shares.map((s) => [s.userId, s.owedCents]));
      const v = participantIds
        .map((userId) => ({ userId, value: owed.get(userId) ?? 0 }))
        .filter((x) => x.value > 0);
      intent = { mode: 'exact', participants: v.map((x) => x.userId), values: v, payers };
      break;
    }
    case 'percent': {
      const v = participantIds
        .map((userId) => ({
          userId,
          value: parsePercentInput(split.percentRaw[userId] ?? '') ?? 0,
        }))
        .filter((x) => x.value > 0);
      intent = { mode: 'percent', participants: v.map((x) => x.userId), values: v, payers };
      break;
    }
    case 'shares': {
      const v = participantIds
        .map((userId) => ({ userId, value: split.shareCounts[userId] ?? 0 }))
        .filter((x) => x.value > 0);
      intent = { mode: 'shares', participants: v.map((x) => x.userId), values: v, payers };
      break;
    }
  }
  return {
    description: input.description,
    amountCents: input.amountCents,
    currency: input.currency,
    category: input.category,
    notes: input.notes,
    split: intent,
  };
}

/** Users the template gives a role (paying or charged). */
export function templateUserIds(t: RecurringTemplate): number[] {
  const ids = new Set<number>();
  for (const p of t.split.payers) if (p.cents > 0) ids.add(p.userId);
  if (t.split.mode === 'equal') for (const id of t.split.participants) ids.add(id);
  else for (const v of t.split.values ?? []) if (v.value > 0) ids.add(v.userId);
  return [...ids];
}

/** cents per user, scaled to `amountCents` when the template's own total differs. */
function scaled(
  entries: { userId: number; cents: number }[],
  amountCents: number,
): { userId: number; cents: number }[] {
  const sum = entries.reduce((s, e) => s + e.cents, 0);
  if (sum === amountCents) return entries;
  return splitByWeights(
    amountCents,
    entries.map((e) => ({ userId: e.userId, weight: e.cents })),
  ).map((o) => ({ userId: o.userId, cents: o.owedCents }));
}

/**
 * Form values for a rule's template (reviewing a due item, or editing the
 * rule), revalidated against today's group roster / friends — departed people
 * are dropped with a visible note, exactly like a repeated expense.
 */
export function formValuesFromRule(
  rule: RecurringRule,
  sync: SyncData,
  date: string,
): Revalidation {
  const meId = sync.me.id;
  const t = rule.template;
  const group = rule.groupId !== null ? sync.groups.find((g) => g.id === rule.groupId) : undefined;
  const involved = templateUserIds(t);
  const participantIds = group
    ? [...new Set([...group.memberIds, ...involved])]
    : rule.friendId !== null
      ? [meId, rule.friendId]
      : [meId];
  const payers = scaled(t.split.payers, t.amountCents);
  const payer: PayerState =
    payers.length === 1
      ? { mode: 'single', payerId: payers[0].userId, multiRaw: {} }
      : payers.length === 0
        ? defaultPayerState(meId)
        : {
            mode: 'multiple',
            payerId: meId,
            multiRaw: Object.fromEntries(
              payers.map((p) => [p.userId, centsToInput(p.cents, t.currency)]),
            ),
          };
  const base = defaultSplitState(participantIds);
  const values = t.split.values ?? [];
  let split: SplitState;
  switch (t.split.mode) {
    case 'equal':
      split = { ...base, equalChecked: [...t.split.participants] };
      break;
    case 'exact':
      split = {
        ...base,
        mode: 'unequal',
        equalChecked: values.filter((v) => v.value > 0).map((v) => v.userId),
        unequalRaw: Object.fromEntries(
          scaled(
            values.map((v) => ({ userId: v.userId, cents: v.value })),
            t.amountCents,
          ).map((v) => [v.userId, centsToInput(v.cents, t.currency)]),
        ),
      };
      break;
    case 'percent':
      split = {
        ...base,
        mode: 'percent',
        percentRaw: Object.fromEntries(values.map((v) => [v.userId, formatBp(v.value)])),
      };
      break;
    case 'shares':
      split = {
        ...base,
        mode: 'shares',
        shareCounts: Object.fromEntries(
          participantIds.map((id) => [id, values.find((v) => v.userId === id)?.value ?? 0]),
        ),
      };
      break;
  }
  const formValues: ExpenseFormValues = {
    groupId: rule.groupId,
    friendId: rule.friendId,
    description: t.description,
    amountRaw: centsToInput(t.amountCents, t.currency),
    currency: t.currency,
    date,
    category: t.category,
    notes: t.notes ?? '',
    showNotes: Boolean(t.notes),
    payer,
    split,
  };
  const blocking = ruleBlocker(rule, sync);
  if (blocking) return { values: formValues, notes: [], blocking };
  return revalidateFormValues(formValues, sync);
}

/**
 * Why a rule's bill can't be recorded at all right now (its scope is gone),
 * or null. Departed group members are NOT blocking — the form drops them.
 */
export function ruleBlocker(rule: RecurringRule, sync: SyncData): string | null {
  if (rule.groupId !== null) {
    return sync.groups.some((g) => g.id === rule.groupId)
      ? null
      : 'You’re no longer in this group.';
  }
  if (rule.friendId !== null && !sync.friendIds.includes(rule.friendId)) {
    const name = sync.users.find((u) => u.id === rule.friendId)?.name ?? 'This person';
    return `${name} is no longer your friend.`;
  }
  return null;
}

/**
 * Whether a due item can be added straight from the template ("Add all"):
 * its scope is intact and everyone it names is still in the group.
 */
export function canAddAsIs(rule: RecurringRule | undefined, sync: SyncData): boolean {
  if (!rule || ruleBlocker(rule, sync)) return false;
  if (rule.groupId === null) return true;
  const members = new Set(sync.groups.find((g) => g.id === rule.groupId)?.memberIds ?? []);
  return templateUserIds(rule.template).every((id) => members.has(id));
}

/** "Flat" for a group bill, "with Ben" for a 1:1 one. */
export function scopeLabel(
  scope: { groupId: number | null; friendId: number | null },
  sync: SyncData,
): string {
  if (scope.groupId !== null) {
    return sync.groups.find((g) => g.id === scope.groupId)?.name ?? 'A group you left';
  }
  const name = sync.users.find((u) => u.id === scope.friendId)?.name ?? 'someone';
  return `with ${name}`;
}

export interface DueItem {
  occurrence: PendingOccurrence;
  rule: RecurringRule | undefined;
  /** Addable from the template without review. */
  ready: boolean;
}

/** The inbox, oldest due first, each item paired with its rule. */
export function dueItems(sync: SyncData): DueItem[] {
  const rec = sync.recurring;
  if (!rec) return [];
  const rules = new Map(rec.rules.map((r) => [r.id, r]));
  return [...rec.pending]
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id))
    .map((occurrence) => {
      const rule = rules.get(occurrence.ruleId);
      return { occurrence, rule, ready: canAddAsIs(rule, sync) };
    });
}
