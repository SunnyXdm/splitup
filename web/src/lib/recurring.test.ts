import { describe, expect, it } from 'vitest';
import { checkFormValues, emptyFormValues, participantIdsFor, userById } from './expense-form';
import {
  addMonths,
  cadenceLabel,
  canAddAsIs,
  dueItems,
  formValuesFromRule,
  occurrenceDate,
  repeatPlan,
  ruleBlocker,
  templateFromForm,
} from './recurring';
import { ashaLeft, makeSync } from './test-fixtures';
import type { RecurringRule, RecurringTemplate, SyncData } from './types';

const TODAY = '2026-10-07';

const check = (values: Parameters<typeof checkFormValues>[0], sync: SyncData) =>
  checkFormValues(
    values,
    participantIdsFor(values, sync).map((id) => userById(sync, id)),
    sync.me.id,
  );

const rent: RecurringTemplate = {
  description: 'Rent',
  amountCents: 3000,
  currency: 'EUR',
  category: 'home',
  notes: null,
  split: { mode: 'equal', participants: [1, 2, 4], payers: [{ userId: 1, cents: 3000 }] },
};

const rule = (over: Partial<RecurringRule> = {}): RecurringRule => ({
  id: 7,
  createdBy: 1,
  groupId: 10,
  friendId: null,
  template: rent,
  cadence: 'monthly',
  interval: 1,
  anchorDate: '2026-01-31',
  nextDue: '2026-10-31',
  paused: false,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('calendar helpers mirror the server', () => {
  it('clamps month ends without drifting', () => {
    const s = { cadence: 'monthly' as const, interval: 1, anchorDate: '2026-01-31' };
    expect([0, 1, 2].map((n) => occurrenceDate(s, n))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('plans a repeat: past/today dates add now, future dates only schedule', () => {
    expect(repeatPlan('2026-10-01', 'monthly', TODAY)).toEqual({
      addFirst: true,
      firstDue: '2026-11-01',
    });
    expect(repeatPlan(TODAY, 'weekly', TODAY)).toEqual({ addFirst: true, firstDue: '2026-10-14' });
    expect(repeatPlan('2026-11-01', 'yearly', TODAY)).toEqual({
      addFirst: false,
      firstDue: '2026-11-01',
    });
  });

  it('labels cadences', () => {
    expect(cadenceLabel('monthly')).toBe('Monthly');
    expect(cadenceLabel('weekly', 2)).toBe('Every 2 weeks');
  });
});

describe('templateFromForm', () => {
  const sync = makeSync();

  it('keeps an equal split as intent, not cents', () => {
    const values = { ...emptyFormValues(sync, { groupId: 10 }, TODAY), description: 'Rent' };
    values.amountRaw = '30';
    const c = check(values, sync);
    const t = templateFromForm(values, c.input!, participantIdsFor(values, sync));
    expect(t.split).toEqual({
      mode: 'equal',
      participants: [1, 2, 4],
      payers: [{ userId: 1, cents: 3000 }],
    });
  });

  it('stores percentages in basis points and exact splits in cents', () => {
    const base = { ...emptyFormValues(sync, { groupId: 10 }, TODAY), description: 'Wifi' };
    const percent = {
      ...base,
      amountRaw: '10',
      split: { ...base.split, mode: 'percent' as const, percentRaw: { 1: '50', 2: '25', 4: '25' } },
    };
    const tp = templateFromForm(percent, check(percent, sync).input!, [1, 2, 4]);
    expect(tp.split.mode).toBe('percent');
    expect(tp.split.values).toEqual([
      { userId: 1, value: 5000 },
      { userId: 2, value: 2500 },
      { userId: 4, value: 2500 },
    ]);
    const exact = {
      ...base,
      amountRaw: '10',
      split: { ...base.split, mode: 'unequal' as const, unequalRaw: { 1: '7', 2: '3', 4: '' } },
    };
    const te = templateFromForm(exact, check(exact, sync).input!, [1, 2, 4]);
    expect(te.split).toMatchObject({
      mode: 'exact',
      participants: [1, 2],
      values: [
        { userId: 1, value: 700 },
        { userId: 2, value: 300 },
      ],
    });
  });

  it('round-trips through the form to the same expense', () => {
    const shares: RecurringTemplate = {
      ...rent,
      split: {
        mode: 'shares',
        participants: [1, 2],
        values: [
          { userId: 1, value: 2 },
          { userId: 2, value: 1 },
        ],
        payers: [
          { userId: 1, cents: 1000 },
          { userId: 2, cents: 2000 },
        ],
      },
    };
    const { values, blocking } = formValuesFromRule(rule({ template: shares }), sync, TODAY);
    expect(blocking).toBeNull();
    expect(values.date).toBe(TODAY);
    expect(values.payer.mode).toBe('multiple');
    const c = check(values, sync);
    expect(c.input?.shares).toEqual([
      { userId: 1, paidCents: 1000, owedCents: 2000 },
      { userId: 2, paidCents: 2000, owedCents: 1000 },
    ]);
    const again = templateFromForm(values, c.input!, participantIdsFor(values, sync));
    expect(again.split).toEqual(shares.split);
  });
});

describe('revalidation of due items', () => {
  it('drops a departed member with a note, and keeps the item out of "Add all"', () => {
    const sync = ashaLeft();
    const rv = formValuesFromRule(rule(), sync, TODAY);
    expect(rv.blocking).toBeNull();
    expect(rv.notes[0]).toMatch(/Asha/);
    expect(rv.values.split.equalChecked).toEqual([1, 2]);
    expect(canAddAsIs(rule(), sync)).toBe(false);
    expect(canAddAsIs(rule(), makeSync())).toBe(true);
  });

  it('blocks when the group or the friend is gone', () => {
    const sync = makeSync({ groups: [] });
    expect(ruleBlocker(rule(), sync)).toMatch(/no longer in this group/);
    const oneToOne = rule({ groupId: null, friendId: 2 });
    expect(ruleBlocker(oneToOne, makeSync())).toBeNull();
    expect(ruleBlocker(oneToOne, makeSync({ friendIds: [3] }))).toBe(
      'Ben is no longer your friend.',
    );
    expect(formValuesFromRule(oneToOne, makeSync({ friendIds: [3] }), TODAY).blocking).toMatch(
      /Ben/,
    );
  });

  it('lists the inbox oldest first with readiness', () => {
    const sync = makeSync({
      recurring: {
        rules: [rule()],
        pending: [
          {
            id: 2,
            ruleId: 7,
            dueDate: '2026-10-01',
            description: 'Rent',
            amountCents: 3000,
            currency: 'EUR',
            groupId: 10,
            friendId: null,
          },
          {
            id: 1,
            ruleId: 7,
            dueDate: '2026-09-01',
            description: 'Rent',
            amountCents: 3000,
            currency: 'EUR',
            groupId: 10,
            friendId: null,
          },
          {
            id: 3,
            ruleId: 99,
            dueDate: '2026-09-15',
            description: 'Gone',
            amountCents: 1,
            currency: 'EUR',
            groupId: 10,
            friendId: null,
          },
        ],
      },
    });
    const items = dueItems(sync);
    expect(items.map((i) => i.occurrence.id)).toEqual([1, 3, 2]);
    expect(items.map((i) => i.ready)).toEqual([true, false, true]);
  });
});
