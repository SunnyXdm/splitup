import { describe, expect, it } from 'vitest';
import { firstMonth, groupSummary, personalSummary, summarize } from './summary';
import { makeSync } from './test-fixtures';
import type { Category, Expense, ExpenseShare, SettlementBatch, SyncData } from './types';

let idSeq = 1;

function exp(o: {
  amount: number;
  shares: ExpenseShare[];
  currency?: string;
  date?: string;
  category?: Category;
  isPayment?: boolean;
  groupId?: number | null;
}): Expense {
  return {
    id: idSeq++,
    groupId: o.groupId === undefined ? 9 : o.groupId,
    description: `E${idSeq}`,
    amountCents: o.amount,
    currency: o.currency ?? 'INR',
    date: o.date ?? '2026-10-03',
    category: o.category ?? 'general',
    notes: null,
    isPayment: o.isPayment ?? false,
    shares: o.shares,
    createdBy: 1,
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
  };
}

const ME = 1;

describe('summarize', () => {
  const dinner = exp({
    amount: 3000,
    category: 'food',
    shares: [
      { userId: 1, paidCents: 3000, owedCents: 1000 },
      { userId: 2, paidCents: 0, owedCents: 1000 },
      { userId: 3, paidCents: 0, owedCents: 1000 },
    ],
  });
  const hotel = exp({
    amount: 9000,
    category: 'travel',
    shares: [
      { userId: 2, paidCents: 9000, owedCents: 3000 },
      { userId: 1, paidCents: 0, owedCents: 3000 },
      { userId: 3, paidCents: 0, owedCents: 3000 },
    ],
  });
  const notMine = exp({
    amount: 500,
    category: 'food',
    shares: [
      { userId: 2, paidCents: 500, owedCents: 250 },
      { userId: 3, paidCents: 0, owedCents: 250 },
    ],
  });
  const paidToMe = exp({
    amount: 1000,
    isPayment: true,
    shares: [
      { userId: 2, paidCents: 1000, owedCents: 0 },
      { userId: 1, paidCents: 0, owedCents: 1000 },
    ],
  });
  const iPaid = exp({
    amount: 700,
    isPayment: true,
    shares: [
      { userId: 1, paidCents: 700, owedCents: 0 },
      { userId: 2, paidCents: 0, owedCents: 700 },
    ],
  });

  it('separates consumption, what I paid, and payments', () => {
    const [inr] = summarize([dinner, hotel, notMine, paidToMe, iPaid], ME);
    expect(inr).toMatchObject({
      currency: 'INR',
      totalCents: 12500, // payments excluded
      expenseCount: 3,
      myShareCents: 4000, // 1000 + 3000 — NOT the net balance
      myPaidCents: 3000,
      paymentsSentCents: 700,
      paymentsReceivedCents: 1000,
    });
    expect(inr.categories).toEqual([
      { category: 'travel', cents: 3000 },
      { category: 'food', cents: 1000 },
    ]);
    expect(inr.top.map((e) => e.id)).toEqual([hotel.id, dinner.id, notMine.id]);
  });

  it('a payments-only currency has zero spending', () => {
    const [inr] = summarize([paidToMe], ME);
    expect(inr.totalCents).toBe(0);
    expect(inr.myShareCents).toBe(0);
    expect(inr.top).toEqual([]);
    expect(inr.categories).toEqual([]);
    expect(inr.paymentsReceivedCents).toBe(1000);
  });

  it('never sums across currencies', () => {
    const usd = exp({
      amount: 2000,
      currency: 'USD',
      shares: [
        { userId: 1, paidCents: 2000, owedCents: 1000 },
        { userId: 2, paidCents: 0, owedCents: 1000 },
      ],
    });
    const jpy = exp({
      amount: 3000,
      currency: 'JPY',
      shares: [{ userId: 1, paidCents: 3000, owedCents: 3000 }],
    });
    const out = summarize([dinner, usd, jpy], ME);
    expect(out.map((s) => [s.currency, s.totalCents, s.myShareCents])).toEqual([
      ['INR', 3000, 1000],
      ['JPY', 3000, 3000],
      ['USD', 2000, 1000],
    ]);
  });

  it('keeps the top 5 by amount, newest first on ties', () => {
    const rows = [100, 900, 300, 900, 50, 700, 800, 200].map((amount, i) =>
      exp({
        amount,
        date: `2026-10-0${i + 1}`,
        shares: [{ userId: 1, paidCents: amount, owedCents: amount }],
      }),
    );
    const [s] = summarize(rows, ME);
    expect(s.top.map((e) => [e.amountCents, e.date])).toEqual([
      [900, '2026-10-04'],
      [900, '2026-10-02'],
      [800, '2026-10-07'],
      [700, '2026-10-06'],
      [300, '2026-10-03'],
    ]);
  });

  it('respects inclusive date ranges at month boundaries', () => {
    const mk = (date: string) =>
      exp({
        amount: 100,
        date,
        shares: [{ userId: 1, paidCents: 100, owedCents: 100 }],
      });
    const rows = [mk('2026-09-30'), mk('2026-10-01'), mk('2026-10-31'), mk('2026-11-01')];
    const [s] = summarize(rows, ME, { from: '2026-10-01', to: '2026-10-31' });
    expect(s.expenseCount).toBe(2);
    expect(summarize(rows, ME, { from: '2027-01-01', to: null })).toEqual([]);
  });
});

describe('snapshot helpers', () => {
  const rows = [
    exp({
      amount: 1000,
      groupId: 9,
      date: '2026-08-14',
      shares: [{ userId: 1, paidCents: 1000, owedCents: 1000 }],
    }),
    exp({
      amount: 400,
      groupId: 9,
      shares: [
        { userId: 2, paidCents: 400, owedCents: 200 },
        { userId: 3, paidCents: 0, owedCents: 200 },
      ],
    }),
    exp({
      amount: 600,
      groupId: null,
      shares: [
        { userId: 1, paidCents: 600, owedCents: 300 },
        { userId: 2, paidCents: 0, owedCents: 300 },
      ],
    }),
  ];
  const sync: SyncData = {
    me: {
      id: 1,
      name: 'Me',
      email: null,
      picture: null,
      defaultCurrency: 'INR',
    },
    users: [],
    friendIds: [],
    groups: [
      {
        id: 9,
        name: 'Trip',
        emoji: '🏖️',
        currency: 'INR',
        createdBy: 1,
        createdAt: '',
        memberIds: [1, 2, 3],
      },
    ],
    expenses: rows,
    activity: [],
    syncedAt: '',
  };
  const all = { from: null, to: null };

  it('group summary counts every group expense; personal only mine', () => {
    expect(groupSummary(sync, 9, all)[0].totalCents).toBe(1400);
    expect(personalSummary(sync, all)[0]).toMatchObject({
      totalCents: 1600,
      myShareCents: 1300,
    });
  });

  it('memoizes per snapshot and range', () => {
    expect(groupSummary(sync, 9, all)).toBe(groupSummary(sync, 9, all));
    const oct = { from: '2026-10-01', to: '2026-10-31' };
    expect(groupSummary(sync, 9, oct)).not.toBe(groupSummary(sync, 9, all));
    expect(groupSummary(sync, 9, oct)[0].totalCents).toBe(400);
    expect(groupSummary({ ...sync }, 9, all)).not.toBe(groupSummary(sync, 9, all));
  });

  it('firstMonth is the earliest month I took part in', () => {
    expect(firstMonth(sync)).toBe('2026-08');
  });
});

describe('settle-up batches', () => {
  const pay = (o: {
    groupId: number | null;
    from: number;
    to: number;
    amount: number;
    batch?: number;
    date?: string;
  }): Expense => ({
    ...exp({
      amount: o.amount,
      isPayment: true,
      groupId: o.groupId,
      date: o.date,
      shares: [
        { userId: o.from, paidCents: o.amount, owedCents: 0 },
        { userId: o.to, paidCents: 0, owedCents: o.amount },
      ],
    }),
    settlementBatchId: o.batch ?? null,
  });
  const batch = (o: Partial<SettlementBatch> & { id: number }): SettlementBatch => ({
    payerId: ME,
    payeeId: 2,
    amountCents: 0,
    currency: 'INR',
    date: '2026-10-03',
    method: null,
    reference: null,
    note: null,
    createdBy: ME,
    createdAt: '2026-10-03T00:00:00Z',
    rows: [],
    ...o,
  });

  // I paid friend 2 a net 800: 1000 in group 9, offset by a 200 counter row
  // in group 8 (2 → me). Rows alone would read as 1000 sent + 200 received.
  const rows = [
    pay({ groupId: 9, from: ME, to: 2, amount: 1000, batch: 50 }),
    pay({ groupId: 8, from: 2, to: ME, amount: 200, batch: 50 }),
  ];
  const settle = batch({ id: 50, amountCents: 800, rows: rows.map((r) => r.id) });

  it('counts a batch once, as the net cash', () => {
    expect(summarize(rows, ME, undefined, [settle])[0]).toMatchObject({
      paymentsSentCents: 800,
      paymentsReceivedCents: 0,
    });
  });

  it('keeps legacy payments and unknown batches row by row', () => {
    const legacy = pay({ groupId: null, from: 2, to: ME, amount: 300 });
    expect(summarize([...rows, legacy], ME)[0]).toMatchObject({
      paymentsSentCents: 1000,
      paymentsReceivedCents: 500,
    });
    expect(summarize([...rows, legacy], ME, undefined, [settle])[0]).toMatchObject({
      paymentsSentCents: 800,
      paymentsReceivedCents: 300,
    });
  });

  it('filters a batch by its own date', () => {
    const range = { from: '2026-11-01', to: '2026-11-30' };
    expect(summarize(rows, ME, range, [settle])).toEqual([]);
  });

  it('personal summary uses the batches; a group summary shows its allocation', () => {
    const base = makeSync();
    const sync: SyncData = {
      ...base,
      groups: [{ ...base.groups[0], id: 9, currency: 'INR', memberIds: [ME, 2] }],
      expenses: rows,
      settlementBatches: [settle],
    };
    const all = { from: null, to: null };
    expect(personalSummary(sync, all)[0]).toMatchObject({ paymentsSentCents: 800 });
    expect(groupSummary(sync, 9, all)[0]).toMatchObject({ paymentsSentCents: 1000 });
  });
});
