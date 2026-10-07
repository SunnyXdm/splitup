import { describe, expect, it } from 'vitest';
import { checkFormValues, participantIdsFor, userById } from './expense-form';
import { buildRepeatPrefill } from './repeat';
import { ashaLeft, makeExpense, makeSync } from './test-fixtures';
import type { SyncData } from './types';

const TODAY = '2026-10-07';

const inputOf = (values: Parameters<typeof checkFormValues>[0], sync: SyncData) =>
  checkFormValues(
    values,
    participantIdsFor(values, sync).map((id) => userById(sync, id)),
    sync.me.id,
  ).input;

describe('buildRepeatPrefill', () => {
  it('copies scope, text, amount, category and notes, dated today', () => {
    const sync = makeSync();
    const { values, notes, blocking } = buildRepeatPrefill(makeExpense(), sync, TODAY);
    expect(blocking).toBeNull();
    expect(notes).toEqual([]);
    expect(values).toMatchObject({
      groupId: 10,
      friendId: null,
      description: 'Groceries',
      amountRaw: '30.00',
      currency: 'EUR',
      date: TODAY,
      category: 'groceries',
      notes: 'Weekly shop',
      showNotes: true,
    });
  });

  it('prefills an equal split when every share is the equal split', () => {
    const { values } = buildRepeatPrefill(makeExpense(), makeSync(), TODAY);
    expect(values.split.mode).toBe('equal');
    expect(values.split.equalChecked).toEqual([1, 2, 4]);
  });

  it('treats equal-with-remainder cents as equal (1001 / 3 = 334, 334, 333)', () => {
    const expense = makeExpense({
      amountCents: 1001,
      shares: [
        { userId: 1, paidCents: 1001, owedCents: 334 },
        { userId: 2, paidCents: 0, owedCents: 334 },
        { userId: 4, paidCents: 0, owedCents: 333 },
      ],
    });
    expect(buildRepeatPrefill(expense, makeSync(), TODAY).values.split.mode).toBe('equal');
  });

  it('prefills exact amounts as an unequal split and reproduces the same shares', () => {
    const sync = makeSync();
    const expense = makeExpense({
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 500 },
        { userId: 2, paidCents: 0, owedCents: 2500 },
      ],
    });
    const { values } = buildRepeatPrefill(expense, sync, TODAY);
    expect(values.split.mode).toBe('unequal');
    expect(values.split.unequalRaw).toMatchObject({ 1: '5.00', 2: '25.00', 4: '' });
    expect(inputOf(values, sync)?.shares).toEqual(expense.shares);
  });

  it('keeps multiple payers', () => {
    const sync = makeSync();
    const expense = makeExpense({
      shares: [
        { userId: 1, paidCents: 1000, owedCents: 1000 },
        { userId: 2, paidCents: 2000, owedCents: 1000 },
        { userId: 4, paidCents: 0, owedCents: 1000 },
      ],
    });
    const { values } = buildRepeatPrefill(expense, sync, TODAY);
    expect(values.payer.mode).toBe('multiple');
    expect(inputOf(values, sync)?.shares).toEqual(expense.shares);
  });

  it('drops a departed member with a note; an equal split stays equal among the rest', () => {
    const sync = ashaLeft();
    const { values, notes } = buildRepeatPrefill(makeExpense(), sync, TODAY);
    expect(notes).toContain('Removed Asha — no longer in this group');
    expect(notes).toContain('Split equally between the remaining people');
    expect(values.split).toMatchObject({ mode: 'equal', equalChecked: [1, 2] });
    expect(inputOf(values, sync)?.shares).toEqual([
      { userId: 1, paidCents: 3000, owedCents: 1500 },
      { userId: 2, paidCents: 0, owedCents: 1500 },
    ]);
  });

  it('falls back to equal when dropping someone breaks an exact split', () => {
    const sync = ashaLeft();
    const expense = makeExpense({
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 500 },
        { userId: 2, paidCents: 0, owedCents: 500 },
        { userId: 4, paidCents: 0, owedCents: 2000 },
      ],
    });
    const { values, notes } = buildRepeatPrefill(expense, sync, TODAY);
    expect(notes).toEqual([
      'Removed Asha — no longer in this group',
      'Split reset to equal between the remaining people',
    ]);
    expect(values.split).toMatchObject({ mode: 'equal', equalChecked: [1, 2] });
    expect(inputOf(values, sync)).not.toBeNull();
  });

  it('resets the payer to you when the payer left', () => {
    const sync = ashaLeft();
    const expense = makeExpense({
      shares: [
        { userId: 1, paidCents: 0, owedCents: 1500 },
        { userId: 2, paidCents: 0, owedCents: 1500 },
        { userId: 4, paidCents: 3000, owedCents: 0 },
      ],
    });
    const { values, notes } = buildRepeatPrefill(expense, sync, TODAY);
    expect(notes).toContain('Paid by reset to you');
    expect(values.payer).toEqual({ mode: 'single', payerId: 1, multiRaw: {} });
    // Asha owed nothing, so the exact split still adds up and is kept.
    expect(values.split.mode).toBe('equal');
    expect(inputOf(values, sync)).not.toBeNull();
  });

  it('repeats a 1:1 expense with the same friend', () => {
    const sync = makeSync();
    const expense = makeExpense({
      groupId: null,
      currency: 'USD',
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 1000 },
        { userId: 3, paidCents: 0, owedCents: 2000 },
      ],
    });
    const { values, notes } = buildRepeatPrefill(expense, sync, TODAY);
    expect(notes).toEqual([]);
    expect(values).toMatchObject({ groupId: null, friendId: 3, currency: 'USD' });
    expect(inputOf(values, sync)?.shares).toEqual(expense.shares);
  });

  it('drops an ex-friend and asks for a new counterparty', () => {
    const sync = { ...makeSync(), friendIds: [2] };
    const expense = makeExpense({
      groupId: null,
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 1500 },
        { userId: 3, paidCents: 0, owedCents: 1500 },
      ],
    });
    const { values, notes } = buildRepeatPrefill(expense, sync, TODAY);
    expect(notes[0]).toBe('Removed Cara — no longer your friend');
    expect(values.friendId).toBeNull();
    expect(values.split.mode).toBe('equal');
  });

  it('is unavailable for payments and for groups you left', () => {
    expect(
      buildRepeatPrefill(makeExpense({ isPayment: true }), makeSync(), TODAY).blocking,
    ).toMatch(/Payments/);
    expect(buildRepeatPrefill(makeExpense({ groupId: 99 }), makeSync(), TODAY).blocking).toMatch(
      /no longer in this group/,
    );
  });
});
