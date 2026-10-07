import { describe, expect, it } from 'vitest';
import {
  acrossLabel,
  activityEvents,
  batchInContext,
  expenseRowFact,
  isOneToOne,
  myStake,
  payersLabel,
} from './history-rows';
import { makeExpense } from './test-fixtures';
import type { ActivityItem, Expense, SettlementBatch } from './types';

const ME = 1;

/** ₹1,864 bill in group 10: I paid it all, four equal shares of ₹466. */
const swiggy = makeExpense({
  amountCents: 186_400,
  shares: [
    { userId: 1, paidCents: 186_400, owedCents: 46_600 },
    { userId: 2, paidCents: 0, owedCents: 46_600 },
    { userId: 3, paidCents: 0, owedCents: 46_600 },
    { userId: 4, paidCents: 0, owedCents: 46_600 },
  ],
});

const direct = makeExpense({
  groupId: null,
  amountCents: 1000,
  shares: [
    { userId: 1, paidCents: 1000, owedCents: 500 },
    { userId: 2, paidCents: 0, owedCents: 500 },
  ],
});

describe('myStake', () => {
  it('reports paid, share and net', () => {
    expect(myStake(swiggy, ME)).toEqual({
      paidCents: 186_400,
      shareCents: 46_600,
      netCents: 139_800,
      involved: true,
    });
    expect(myStake(swiggy, 9).involved).toBe(false);
  });

  it('counts a 0/0 share row as not involved', () => {
    const e = makeExpense({ shares: [{ userId: 1, paidCents: 0, owedCents: 0 }] });
    expect(myStake(e, ME).involved).toBe(false);
  });
});

describe('expenseRowFact', () => {
  it('shows my whole-expense net in group and global lists', () => {
    expect(expenseRowFact(swiggy, ME, { kind: 'group', groupId: 10 })).toEqual({
      kind: 'net',
      cents: 139_800,
    });
    expect(expenseRowFact(swiggy, ME, { kind: 'all' })).toEqual({ kind: 'net', cents: 139_800 });
  });

  it('never attributes a shared bill’s net to one friend (ASTRA #1)', () => {
    // On Ben's page, "you lent ₹1,398" would claim Ben owes it all — show my share.
    expect(expenseRowFact(swiggy, ME, { kind: 'friend', friendId: 2 })).toEqual({
      kind: 'share',
      cents: 46_600,
    });
  });

  it('keeps the net for a 1:1 bill on that friend’s page', () => {
    expect(expenseRowFact(direct, ME, { kind: 'friend', friendId: 2 })).toEqual({
      kind: 'net',
      cents: 500,
    });
  });

  it('separates “no balance change” from “not involved”', () => {
    const even = makeExpense({
      shares: [
        { userId: 1, paidCents: 1000, owedCents: 1000 },
        { userId: 2, paidCents: 2000, owedCents: 2000 },
      ],
    });
    expect(expenseRowFact(even, ME, { kind: 'group', groupId: 10 })).toEqual({ kind: 'even' });
    expect(expenseRowFact(swiggy, 9, { kind: 'group', groupId: 10 })).toEqual({ kind: 'none' });
  });

  it('a shared bill I paid for but have no share in: not a share fact on a friend page', () => {
    const forOthers = makeExpense({
      shares: [
        { userId: 1, paidCents: 2000, owedCents: 0 },
        { userId: 2, paidCents: 0, owedCents: 1000 },
        { userId: 4, paidCents: 0, owedCents: 1000 },
      ],
    });
    expect(expenseRowFact(forOthers, ME, { kind: 'friend', friendId: 2 })).toEqual({
      kind: 'none',
    });
  });
});

describe('isOneToOne', () => {
  it('needs no group and exactly me plus the other person', () => {
    expect(isOneToOne(direct, ME)).toBe(true);
    expect(isOneToOne(direct, ME, 2)).toBe(true);
    expect(isOneToOne(direct, ME, 3)).toBe(false);
    expect(isOneToOne(swiggy, ME)).toBe(false);
  });
});

describe('payersLabel', () => {
  const nameOf = (id: number) => (id === ME ? 'You' : `P${id}`);
  it('names one payer, counts several', () => {
    expect(payersLabel(swiggy, nameOf)).toBe('You paid');
    const two = makeExpense({
      shares: [
        { userId: 1, paidCents: 1000, owedCents: 1500 },
        { userId: 2, paidCents: 2000, owedCents: 1500 },
      ],
    });
    expect(payersLabel(two, nameOf)).toBe('2 people paid');
  });
});

/* ---------------------------------------------------------------- batches */

const PRIYA = 3;
const row = (
  id: number,
  groupId: number | null,
  payerId: number,
  recipientId: number,
  amountCents: number,
): Expense =>
  makeExpense({
    id,
    groupId,
    isPayment: true,
    description: 'Payment',
    amountCents,
    currency: 'INR',
    settlementBatchId: 7,
    shares: [
      { userId: payerId, paidCents: amountCents, owedCents: 0 },
      { userId: recipientId, paidCents: 0, owedCents: amountCents },
    ],
  });

/** Priya paid me ₹8,380: ₹5,000 in group 20, ₹3,380 in group 21. */
const batch: SettlementBatch = {
  id: 7,
  payerId: PRIYA,
  payeeId: ME,
  amountCents: 838_000,
  currency: 'INR',
  date: '2026-10-05',
  method: 'upi',
  reference: null,
  note: null,
  createdBy: PRIYA,
  createdAt: '2026-10-05T10:00:00Z',
  rows: [1, 2],
};
const inFlat = row(1, 20, PRIYA, ME, 500_000);
const inGoa = row(2, 21, PRIYA, ME, 338_000);

describe('batchInContext', () => {
  it('shows the cash once when every row is in view', () => {
    expect(batchInContext(batch, [inFlat, inGoa], [inFlat, inGoa])).toEqual({
      cents: 838_000,
      partial: false,
      offset: false,
      totalCents: 838_000,
    });
  });

  it('shows only the part applied here on a group page', () => {
    expect(batchInContext(batch, [inFlat], [inFlat, inGoa])).toEqual({
      cents: 500_000,
      partial: true,
      offset: false,
      totalCents: 838_000,
    });
  });

  it('flags an offsetting part that runs against the cash', () => {
    // ₹50,985 owed to me in one group, ₹3,070 I owed in another: ₹47,915 cash.
    const big = row(3, 20, PRIYA, ME, 5_098_500);
    const counter = row(4, 22, ME, PRIYA, 307_000);
    const net = { ...batch, amountCents: 4_791_500, rows: [3, 4] };
    expect(batchInContext(net, [counter], [big, counter])).toEqual({
      cents: 307_000,
      partial: true,
      offset: true,
      totalCents: 4_791_500,
    });
  });
});

describe('acrossLabel', () => {
  it('describes multi-scope payments', () => {
    expect(acrossLabel([inFlat])).toBeNull();
    expect(acrossLabel([inFlat, inGoa])).toBe('across 2 groups');
    expect(acrossLabel([inFlat, row(5, null, PRIYA, ME, 1)])).toBe('across 1 group and direct');
  });
});

describe('activityEvents', () => {
  const item = (
    id: number,
    type: ActivityItem['type'],
    expenseId: number | null,
    createdAt: string,
  ): ActivityItem => ({
    id,
    actorId: PRIYA,
    type,
    groupId: null,
    expenseId,
    summary: '',
    createdAt,
  });
  const expensesById = new Map([inFlat, inGoa].map((e) => [e.id, e]));
  const batchesById = new Map([[batch.id, batch]]);

  it('folds the payment rows of one settle-up into one event', () => {
    const events = activityEvents(
      [
        item(10, 'payment_added', 1, '2026-10-05T10:00:00Z'),
        item(11, 'payment_added', 2, '2026-10-05T10:00:01Z'),
        item(12, 'expense_added', 99, '2026-10-06T10:00:00Z'),
        item(9, 'expense_added', 98, '2026-10-01T10:00:00Z'),
      ],
      expensesById,
      batchesById,
    );
    expect(events.map((e) => e.key)).toEqual(['a12', 'b7', 'a9']);
    const b = events[1];
    expect(b.kind === 'batch' && b.items.map((i) => i.id)).toEqual([10, 11]);
    expect(b.createdAt).toBe('2026-10-05T10:00:01Z');
  });

  it('keeps payments whose row or batch is unknown as single items', () => {
    const events = activityEvents(
      [
        item(20, 'payment_added', 404, '2026-10-05T10:00:00Z'),
        item(21, 'payment_added', null, '2026-10-04T10:00:00Z'),
      ],
      expensesById,
      new Map(),
    );
    expect(events.map((e) => e.kind)).toEqual(['item', 'item']);
  });
});
