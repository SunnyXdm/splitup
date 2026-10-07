import { describe, expect, it } from 'vitest';
import { checkFormValues, emptyFormValues, formValuesFromExpense } from '@/lib/expense-form';
import { makeExpense, makeSync, user } from '@/lib/test-fixtures';
import {
  defaultSplitState,
  splitMetaFromState,
  splitMetaMatches,
  splitStateFromExpense,
  withSplitMode,
} from './split-state';

const people = [user(1, 'Me'), user(2, 'Ben'), user(4, 'Asha')];
const ids = [1, 2, 4];

describe('restoring a split on edit', () => {
  it('restores the stored mode and parameters', () => {
    const percent = makeExpense({
      amountCents: 1000,
      shares: [
        { userId: 1, paidCents: 1000, owedCents: 250 },
        { userId: 2, paidCents: 0, owedCents: 750 },
      ],
      split: { mode: 'percent', participants: [1, 2], values: { '1': 2500, '2': 7500 } },
    });
    const r = splitStateFromExpense(percent, ids);
    expect(r.legacy).toBe(false);
    expect(r.state.mode).toBe('percent');
    expect(r.state.percentRaw).toEqual({ 1: '25', 2: '75', 4: '' });

    const shares = makeExpense({
      amountCents: 1000,
      shares: [
        { userId: 1, paidCents: 1000, owedCents: 250 },
        { userId: 4, paidCents: 0, owedCents: 750 },
      ],
      split: { mode: 'shares', participants: [1, 4], values: { '1': 1, '4': 3 } },
    });
    expect(splitStateFromExpense(shares, ids).state).toMatchObject({
      mode: 'shares',
      shareCounts: { 1: 1, 2: 0, 4: 3 },
    });
  });

  it('opens an equal split as Equal, even without a stored method', () => {
    const r = splitStateFromExpense(makeExpense(), ids);
    expect(r).toMatchObject({ legacy: false, state: { mode: 'equal', equalChecked: [1, 2, 4] } });
  });

  it('treats a stored equal split over a subset as Equal over that subset', () => {
    const e = makeExpense({
      amountCents: 1001,
      shares: [
        { userId: 1, paidCents: 1001, owedCents: 501 },
        { userId: 2, paidCents: 0, owedCents: 500 },
      ],
      split: { mode: 'equal', participants: [2, 1] },
    });
    expect(splitStateFromExpense(e, ids).state).toMatchObject({
      mode: 'equal',
      equalChecked: [2, 1],
    });
  });

  it('falls back to exact amounts (legacy) when nothing describes the split', () => {
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 500 },
        { userId: 2, paidCents: 0, owedCents: 2500 },
      ],
    });
    const r = splitStateFromExpense(e, ids);
    expect(r.legacy).toBe(true);
    expect(r.state.mode).toBe('unequal');
    expect(r.state.unequalRaw).toEqual({ 1: '5.00', 2: '25.00', 4: '' });
  });

  it('ignores a stale description that no longer matches the shares', () => {
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 500 },
        { userId: 2, paidCents: 0, owedCents: 2500 },
      ],
      split: { mode: 'equal', participants: [1, 2] },
    });
    expect(splitMetaMatches(e.split!, e.amountCents, e.shares)).toBe(false);
    expect(splitStateFromExpense(e, ids).legacy).toBe(true);
  });
});

describe('split description sent on save', () => {
  it('round-trips through checkFormValues and back into the editor', () => {
    const sync = makeSync();
    const values = {
      ...emptyFormValues(sync, { groupId: 10 }, '2026-10-01'),
      description: 'Dinner',
      amountRaw: '10',
      split: {
        ...defaultSplitState(ids),
        mode: 'shares' as const,
        shareCounts: { 1: 2, 2: 1, 4: 0 },
      },
    };
    const { input } = checkFormValues(values, people, 1);
    expect(input?.split).toEqual({
      mode: 'shares',
      participants: [1, 2],
      values: { '1': 2, '2': 1 },
    });
    const saved = makeExpense({ ...input!, amountCents: input!.amountCents });
    const back = formValuesFromExpense(saved, 1, ids);
    expect(back.split).toMatchObject({ mode: 'shares', shareCounts: { 1: 2, 2: 1, 4: 0 } });
  });

  it('describes equal splits by who is in them', () => {
    const shares = [
      { userId: 1, owedCents: 334 },
      { userId: 2, owedCents: 333 },
      { userId: 4, owedCents: 333 },
    ];
    expect(splitMetaFromState(defaultSplitState(ids), ids, 1000, shares)).toEqual({
      mode: 'equal',
      participants: [1, 2, 4],
    });
  });
});

describe('switching split method', () => {
  it('starts Percent and Unequal from the even split instead of blanks', () => {
    const base = defaultSplitState(ids);
    expect(withSplitMode(base, 'percent', ids, 2400, 'EUR').percentRaw).toEqual({
      1: '33.34',
      2: '33.33',
      4: '33.33',
    });
    expect(withSplitMode(base, 'unequal', ids, 2400, 'EUR').unequalRaw).toEqual({
      1: '8.00',
      2: '8.00',
      4: '8.00',
    });
  });

  it('spreads only over the people included in the equal split', () => {
    const base = { ...defaultSplitState(ids), equalChecked: [1, 2] };
    expect(withSplitMode(base, 'percent', ids, 1000, 'EUR').percentRaw).toEqual({
      1: '50',
      2: '50',
      4: '',
    });
  });

  it('keeps what was already typed', () => {
    const base = { ...defaultSplitState(ids), percentRaw: { 1: '10' } };
    expect(withSplitMode(base, 'percent', ids, 1000, 'EUR').percentRaw).toEqual({ 1: '10' });
  });
});
