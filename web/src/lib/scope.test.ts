import { describe, expect, it } from 'vitest';
import {
  applyScope,
  checkFormValues,
  emptyFormValues,
  formSummary,
  scopeChoiceOf,
  scopeTitle,
} from './expense-form';
import { scopeOptions } from './scope';
import { makeExpense, makeSync, user } from './test-fixtures';
import type { Group, SyncData } from './types';

const group = (over: Partial<Group>): Group => ({
  id: 0,
  name: 'G',
  emoji: '🧾',
  currency: 'USD',
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00Z',
  memberIds: [1, 2],
  ...over,
});

function richSync(): SyncData {
  const base = makeSync();
  return {
    ...base,
    groups: [
      ...base.groups,
      group({ id: 11, name: 'Goa trip', createdAt: '2026-05-01T00:00:00Z' }),
      group({ id: 12, name: 'Old flat', archivedAt: '2026-06-01T00:00:00Z' }),
    ],
    expenses: [
      makeExpense({ id: 1, groupId: 11, updatedAt: '2026-09-20T00:00:00Z' }),
      makeExpense({ id: 2, groupId: 10, updatedAt: '2026-08-01T00:00:00Z' }),
      makeExpense({
        id: 3,
        groupId: null,
        currency: 'USD',
        updatedAt: '2026-09-25T00:00:00Z',
        shares: [
          { userId: 1, paidCents: 3000, owedCents: 1500 },
          { userId: 3, paidCents: 0, owedCents: 1500 },
        ],
      }),
    ],
  };
}

describe('scope picker options', () => {
  it('lists groups by recent activity and hides archived ones', () => {
    const { groups } = scopeOptions(richSync());
    expect(groups.map((g) => g.name)).toEqual(['Goa trip', 'Flat']);
  });

  it('lists friends with recent direct expenses first, then by name', () => {
    const { friends } = scopeOptions(richSync());
    expect(friends.map((f) => f.name)).toEqual(['Cara', 'Ben']);
  });

  it('searches names (accent- and case-insensitive), archived groups included', () => {
    const sync = richSync();
    expect(scopeOptions(sync, 'old').groups.map((g) => g.name)).toEqual(['Old flat']);
    expect(scopeOptions(sync, 'old').groups[0].detail).toMatch(/Archived/);
    expect(scopeOptions(sync, 'BEN').friends.map((f) => f.name)).toEqual(['Ben']);
    expect(scopeOptions(sync, 'zzz')).toEqual({ groups: [], friends: [] });
  });

  it('labels a destination by kind, never by a bare name', () => {
    const sync = makeSync();
    expect(scopeTitle({ kind: 'group', groupId: 10 }, sync)).toBe('In Flat');
    expect(scopeTitle({ kind: 'friend', friendId: 3 }, sync)).toBe('Direct with Cara');
  });
});

describe('scope-first form', () => {
  it('never picks a friend on its own and asks for a scope', () => {
    const sync = makeSync();
    const values = emptyFormValues(sync, { groupId: null }, '2026-10-01');
    expect(scopeChoiceOf(values)).toBeNull();
    const check = checkFormValues(
      { ...values, description: 'Taxi', amountRaw: '12' },
      [user(1, 'Me')],
      1,
    );
    expect(check.errors.scope).toBe('Choose a group or friend.');
    expect(check.input).toBeNull();
  });

  it('keeps description, date and notes when the scope changes; revalidates people', () => {
    const sync = makeSync();
    const start = {
      ...emptyFormValues(sync, { groupId: null, friendId: 3 }, '2026-10-01'),
      description: 'Taxi',
      notes: 'Airport',
      showNotes: true,
      amountRaw: '12',
      payer: { mode: 'single' as const, payerId: 3, multiRaw: {} },
    };
    const { values, currencyNotice } = applyScope(start, { kind: 'group', groupId: 10 }, sync);
    expect(values).toMatchObject({
      groupId: 10,
      friendId: null,
      description: 'Taxi',
      notes: 'Airport',
      date: '2026-10-01',
      amountRaw: '12',
      currency: 'EUR',
    });
    // Cara isn't in the group: the payer falls back to me; the split is the new roster.
    expect(values.payer.payerId).toBe(1);
    expect(values.split.equalChecked).toEqual([1, 2, 4]);
    // The digits stay, and the currency change is said out loud.
    expect(currencyNotice).toMatch(/Flat uses EUR/);
    expect(currencyNotice).toMatch(/wasn’t converted from USD/);
  });

  it('keeps the currency when moving to a direct expense', () => {
    const sync = makeSync();
    const start = { ...emptyFormValues(sync, { groupId: 10 }, '2026-10-01'), amountRaw: '5' };
    const { values, currencyNotice } = applyScope(start, { kind: 'friend', friendId: 2 }, sync);
    expect(values).toMatchObject({ groupId: null, friendId: 2, currency: 'EUR' });
    expect(currencyNotice).toBeNull();
  });

  it('summarises who paid and the split on one line', () => {
    const sync = makeSync();
    const values = { ...emptyFormValues(sync, { groupId: 10 }, '2026-10-01'), amountRaw: '24' };
    const people = [user(1, 'Me'), user(2, 'Ben'), user(4, 'Asha')];
    expect(formSummary(values, people, 1, 2400)).toEqual({
      paidBy: 'Paid by you',
      split: 'Equally between 3 people',
      detail: '€8.00 each',
    });
    const split = { ...values.split, equalChecked: [1, 2] };
    const direct = { ...values, groupId: null, friendId: 2, split };
    expect(formSummary(direct, [user(1, 'Me'), user(2, 'BEN STOKES')], 1, 1000).split).toBe(
      'Equally between you and Ben Stokes',
    );
  });
});
