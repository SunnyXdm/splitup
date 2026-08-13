import { describe, expect, it } from 'vitest';
import {
  friendBalance,
  groupBalances,
  myTotalBalance,
  pairwiseForExpense,
  suggestSettlements,
  type NetBalance,
  type Transfer,
} from './balances';
import type { Expense, ExpenseShare, Group, SyncData } from './types';

/** Tiny deterministic LCG for property-style loops (no unseeded randomness). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

let idSeq = 1;

function makeExpense(o: {
  groupId?: number | null;
  currency?: string;
  isPayment?: boolean;
  shares: ExpenseShare[];
}): Expense {
  return {
    id: idSeq++,
    groupId: o.groupId ?? null,
    description: o.isPayment ? 'Payment' : 'Test expense',
    amountCents: o.shares.reduce((sum, s) => sum + s.owedCents, 0),
    currency: o.currency ?? 'USD',
    date: '2026-01-15',
    category: 'general',
    notes: null,
    isPayment: o.isPayment ?? false,
    shares: o.shares,
    createdBy: o.shares[0]?.userId ?? 1,
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
  };
}

function makeGroup(id: number, memberIds: number[], currency = 'USD'): Group {
  return {
    id,
    name: `Group ${id}`,
    emoji: '🧾',
    currency,
    createdBy: memberIds[0],
    createdAt: '2026-01-01T00:00:00Z',
    memberIds,
  };
}

function makeSync(overrides: Partial<SyncData>): SyncData {
  return {
    me: { id: 1, name: 'Me', email: 'me@example.test', picture: null, defaultCurrency: 'USD' },
    users: [],
    friendIds: [],
    groups: [],
    expenses: [],
    activity: [],
    syncedAt: '2026-01-20T00:00:00Z',
    ...overrides,
  };
}

const outgoingOf = (transfers: Transfer[], userId: number): number =>
  transfers.filter((t) => t.fromUserId === userId).reduce((sum, t) => sum + t.cents, 0);

describe('pairwiseForExpense', () => {
  it('attributes a single-payer equal split to the payer', () => {
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 3000, owedCents: 1000 },
        { userId: 2, paidCents: 0, owedCents: 1000 },
        { userId: 3, paidCents: 0, owedCents: 1000 },
      ],
    });
    expect(pairwiseForExpense(e)).toEqual([
      { fromUserId: 2, toUserId: 1, cents: 1000, currency: 'USD' },
      { fromUserId: 3, toUserId: 1, cents: 1000, currency: 'USD' },
    ]);
  });

  it('splits a debtor across multiple payers proportionally to surplus', () => {
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 700, owedCents: 0 },
        { userId: 2, paidCents: 300, owedCents: 0 },
        { userId: 3, paidCents: 0, owedCents: 1000 },
      ],
    });
    expect(pairwiseForExpense(e)).toEqual([
      { fromUserId: 3, toUserId: 1, cents: 700, currency: 'USD' },
      { fromUserId: 3, toUserId: 2, cents: 300, currency: 'USD' },
    ]);
  });

  it('ignores a net-zero payer in a multi-payer expense', () => {
    // 1 paid 2000, 2 paid 1000; equal thirds -> 2 nets to zero
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 2000, owedCents: 1000 },
        { userId: 2, paidCents: 1000, owedCents: 1000 },
        { userId: 3, paidCents: 0, owedCents: 1000 },
      ],
    });
    expect(pairwiseForExpense(e)).toEqual([
      { fromUserId: 3, toUserId: 1, cents: 1000, currency: 'USD' },
    ]);
  });

  it('rounds per debtor so each debtor pays exactly their deficit', () => {
    // creditors: 1 (+333), 2 (+667); debtors: 3 (-500), 4 (-500)
    // exact split per debtor is 166.5 / 333.5 -> largest-remainder, index tie-break
    const e = makeExpense({
      shares: [
        { userId: 1, paidCents: 333, owedCents: 0 },
        { userId: 2, paidCents: 667, owedCents: 0 },
        { userId: 3, paidCents: 0, owedCents: 500 },
        { userId: 4, paidCents: 0, owedCents: 500 },
      ],
    });
    const transfers = pairwiseForExpense(e);
    expect(transfers).toEqual([
      { fromUserId: 3, toUserId: 1, cents: 167, currency: 'USD' },
      { fromUserId: 3, toUserId: 2, cents: 333, currency: 'USD' },
      { fromUserId: 4, toUserId: 1, cents: 167, currency: 'USD' },
      { fromUserId: 4, toUserId: 2, cents: 333, currency: 'USD' },
    ]);
    expect(outgoingOf(transfers, 3)).toBe(500);
    expect(outgoingOf(transfers, 4)).toBe(500);
    // grand total balances even though per-creditor incoming may round ±
    expect(transfers.reduce((sum, t) => sum + t.cents, 0)).toBe(1000);
  });

  it('invariant: per-debtor outgoing equals deficit for random expenses (LCG loop)', () => {
    const rand = lcg(1234);
    // independent integer partition of `amount` into `n` non-negative parts
    const partition = (amount: number, n: number): number[] => {
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * (amount + 1)));
      cuts.sort((a, b) => a - b);
      const parts: number[] = [];
      let prev = 0;
      for (const cut of cuts) {
        parts.push(cut - prev);
        prev = cut;
      }
      parts.push(amount - prev);
      return parts;
    };
    for (let iter = 0; iter < 300; iter++) {
      const n = 2 + Math.floor(rand() * 4);
      const amount = 1 + Math.floor(rand() * 20_000);
      const paid = partition(amount, n);
      const owed = partition(amount, n);
      const shares: ExpenseShare[] = Array.from({ length: n }, (_, i) => ({
        userId: i + 1,
        paidCents: paid[i],
        owedCents: owed[i],
      }));
      const transfers = pairwiseForExpense(makeExpense({ shares }));
      let totalDeficit = 0;
      for (const s of shares) {
        const net = s.paidCents - s.owedCents;
        if (net < 0) {
          totalDeficit += -net;
          expect(outgoingOf(transfers, s.userId)).toBe(-net);
        } else {
          expect(outgoingOf(transfers, s.userId)).toBe(0);
        }
      }
      expect(transfers.reduce((sum, t) => sum + t.cents, 0)).toBe(totalDeficit);
      for (const t of transfers) expect(t.cents).toBeGreaterThan(0);
    }
  });
});

describe('groupBalances', () => {
  it('nets a single-payer equal split and includes zero-net members', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3, 4])],
      expenses: [
        makeExpense({
          groupId: 10,
          shares: [
            { userId: 1, paidCents: 3000, owedCents: 1000 },
            { userId: 2, paidCents: 0, owedCents: 1000 },
            { userId: 3, paidCents: 0, owedCents: 1000 },
          ],
        }),
      ],
    });
    expect(groupBalances(sync, 10)).toEqual([
      { userId: 1, netCents: 2000, currency: 'USD' },
      { userId: 2, netCents: -1000, currency: 'USD' },
      { userId: 3, netCents: -1000, currency: 'USD' },
      { userId: 4, netCents: 0, currency: 'USD' },
    ]);
  });

  it('lists all members at zero in the group currency when there are no expenses', () => {
    const sync = makeSync({ groups: [makeGroup(10, [2, 1], 'EUR')] });
    expect(groupBalances(sync, 10)).toEqual([
      { userId: 1, netCents: 0, currency: 'EUR' },
      { userId: 2, netCents: 0, currency: 'EUR' },
    ]);
  });

  it('a payment cancels an equal debt exactly', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2])],
      expenses: [
        makeExpense({
          groupId: 10,
          shares: [
            { userId: 1, paidCents: 1000, owedCents: 500 },
            { userId: 2, paidCents: 0, owedCents: 500 },
          ],
        }),
        makeExpense({
          groupId: 10,
          isPayment: true,
          shares: [
            { userId: 2, paidCents: 500, owedCents: 0 },
            { userId: 1, paidCents: 0, owedCents: 500 },
          ],
        }),
      ],
    });
    expect(groupBalances(sync, 10)).toEqual([
      { userId: 1, netCents: 0, currency: 'USD' },
      { userId: 2, netCents: 0, currency: 'USD' },
    ]);
    expect(friendBalance(sync, 2)).toEqual([]);
  });

  it('separates currencies and ignores other groups', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2]), makeGroup(20, [1, 2])],
      expenses: [
        makeExpense({
          groupId: 10,
          currency: 'USD',
          shares: [
            { userId: 1, paidCents: 1000, owedCents: 500 },
            { userId: 2, paidCents: 0, owedCents: 500 },
          ],
        }),
        makeExpense({
          groupId: 10,
          currency: 'JPY',
          shares: [
            { userId: 2, paidCents: 300, owedCents: 150 },
            { userId: 1, paidCents: 0, owedCents: 150 },
          ],
        }),
        makeExpense({
          groupId: 20,
          currency: 'USD',
          shares: [
            { userId: 1, paidCents: 900, owedCents: 450 },
            { userId: 2, paidCents: 0, owedCents: 450 },
          ],
        }),
      ],
    });
    expect(groupBalances(sync, 10)).toEqual([
      { userId: 1, netCents: -150, currency: 'JPY' },
      { userId: 2, netCents: 150, currency: 'JPY' },
      { userId: 1, netCents: 500, currency: 'USD' },
      { userId: 2, netCents: -500, currency: 'USD' },
    ]);
  });

  it('returns [] for an unknown group', () => {
    expect(groupBalances(makeSync({}), 99)).toEqual([]);
  });
});

describe('friendBalance / myTotalBalance', () => {
  it('aggregates across groups and non-group expenses', () => {
    const sync = makeSync({
      friendIds: [2, 3],
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [
        // group 10: friend 2 owes me 500, friend 3 owes me 500
        makeExpense({
          groupId: 10,
          shares: [
            { userId: 1, paidCents: 1500, owedCents: 500 },
            { userId: 2, paidCents: 0, owedCents: 500 },
            { userId: 3, paidCents: 0, owedCents: 500 },
          ],
        }),
        // group 20: I owe friend 2 300
        makeExpense({
          groupId: 20,
          shares: [
            { userId: 2, paidCents: 600, owedCents: 300 },
            { userId: 1, paidCents: 0, owedCents: 300 },
          ],
        }),
        // non-group: friend 2 owes me 200
        makeExpense({
          groupId: null,
          shares: [
            { userId: 1, paidCents: 200, owedCents: 0 },
            { userId: 2, paidCents: 0, owedCents: 200 },
          ],
        }),
      ],
    });
    expect(friendBalance(sync, 2)).toEqual([{ currency: 'USD', netCents: 400 }]);
    expect(friendBalance(sync, 3)).toEqual([{ currency: 'USD', netCents: 500 }]);
    expect(myTotalBalance(sync)).toEqual([{ currency: 'USD', netCents: 900 }]);
  });

  it('keeps currencies separate and drops zero entries', () => {
    const sync = makeSync({
      friendIds: [2],
      expenses: [
        makeExpense({
          groupId: null,
          currency: 'USD',
          shares: [
            { userId: 1, paidCents: 500, owedCents: 0 },
            { userId: 2, paidCents: 0, owedCents: 500 },
          ],
        }),
        makeExpense({
          groupId: null,
          currency: 'JPY',
          shares: [
            { userId: 2, paidCents: 800, owedCents: 0 },
            { userId: 1, paidCents: 0, owedCents: 800 },
          ],
        }),
        // EUR nets to zero -> excluded
        makeExpense({
          groupId: null,
          currency: 'EUR',
          shares: [
            { userId: 1, paidCents: 100, owedCents: 0 },
            { userId: 2, paidCents: 0, owedCents: 100 },
          ],
        }),
        makeExpense({
          groupId: null,
          currency: 'EUR',
          isPayment: true,
          shares: [
            { userId: 2, paidCents: 100, owedCents: 0 },
            { userId: 1, paidCents: 0, owedCents: 100 },
          ],
        }),
      ],
    });
    expect(friendBalance(sync, 2)).toEqual([
      { currency: 'JPY', netCents: -800 },
      { currency: 'USD', netCents: 500 },
    ]);
    expect(myTotalBalance(sync)).toEqual([
      { currency: 'JPY', netCents: -800 },
      { currency: 'USD', netCents: 500 },
    ]);
  });

  it('ignores expenses between other people for friendBalance', () => {
    const sync = makeSync({
      friendIds: [2],
      groups: [makeGroup(10, [1, 2, 3])],
      expenses: [
        makeExpense({
          groupId: 10,
          shares: [
            { userId: 2, paidCents: 400, owedCents: 0 },
            { userId: 3, paidCents: 0, owedCents: 400 },
          ],
        }),
      ],
    });
    expect(friendBalance(sync, 2)).toEqual([]);
    expect(myTotalBalance(sync)).toEqual([]);
  });
});

describe('suggestSettlements', () => {
  it('matches largest debtor with largest creditor', () => {
    const balances: NetBalance[] = [
      { userId: 1, netCents: 700, currency: 'USD' },
      { userId: 2, netCents: 300, currency: 'USD' },
      { userId: 3, netCents: -600, currency: 'USD' },
      { userId: 4, netCents: -400, currency: 'USD' },
    ];
    expect(suggestSettlements(balances)).toEqual([
      { fromUserId: 3, toUserId: 1, cents: 600, currency: 'USD' },
      { fromUserId: 4, toUserId: 2, cents: 300, currency: 'USD' },
      { fromUserId: 4, toUserId: 1, cents: 100, currency: 'USD' },
    ]);
  });

  it('breaks ties by lower userId and skips zero nets', () => {
    const balances: NetBalance[] = [
      { userId: 5, netCents: -100, currency: 'USD' },
      { userId: 2, netCents: -100, currency: 'USD' },
      { userId: 9, netCents: 200, currency: 'USD' },
      { userId: 7, netCents: 0, currency: 'USD' },
    ];
    expect(suggestSettlements(balances)).toEqual([
      { fromUserId: 2, toUserId: 9, cents: 100, currency: 'USD' },
      { fromUserId: 5, toUserId: 9, cents: 100, currency: 'USD' },
    ]);
  });

  it('never mixes currencies', () => {
    const balances: NetBalance[] = [
      { userId: 1, netCents: 500, currency: 'USD' },
      { userId: 2, netCents: -500, currency: 'USD' },
      { userId: 1, netCents: -300, currency: 'JPY' },
      { userId: 3, netCents: 300, currency: 'JPY' },
    ];
    expect(suggestSettlements(balances)).toEqual([
      { fromUserId: 1, toUserId: 3, cents: 300, currency: 'JPY' },
      { fromUserId: 2, toUserId: 1, cents: 500, currency: 'USD' },
    ]);
  });

  it('fully settles random nets per currency (LCG loop)', () => {
    const rand = lcg(99);
    const currencies = ['USD', 'JPY', 'EUR'];
    for (let iter = 0; iter < 100; iter++) {
      const balances: NetBalance[] = [];
      for (const currency of currencies.slice(0, 1 + Math.floor(rand() * 3))) {
        const n = 2 + Math.floor(rand() * 6);
        let sum = 0;
        for (let userId = 1; userId < n; userId++) {
          const net = Math.floor(rand() * 20_001) - 10_000;
          sum += net;
          balances.push({ userId, netCents: net, currency });
        }
        balances.push({ userId: n, netCents: -sum, currency });
      }
      const transfers = suggestSettlements(balances);
      // apply every transfer back onto the nets; everything must reach zero
      const remaining = new Map<string, number>();
      for (const b of balances) {
        const key = `${b.currency}:${b.userId}`;
        remaining.set(key, (remaining.get(key) ?? 0) + b.netCents);
      }
      for (const t of transfers) {
        expect(t.cents).toBeGreaterThan(0);
        const fromKey = `${t.currency}:${t.fromUserId}`;
        const toKey = `${t.currency}:${t.toUserId}`;
        remaining.set(fromKey, (remaining.get(fromKey) ?? 0) + t.cents);
        remaining.set(toKey, (remaining.get(toKey) ?? 0) - t.cents);
      }
      for (const [key, net] of remaining) {
        expect(net, `unsettled net for ${key}`).toBe(0);
      }
    }
  });
});

describe('simplified debts stay consistent after net settlement (Darshna bug)', () => {
  it('paying your whole net to one suggested creditor zeroes every friend balance', () => {
    const mk = (id: number, groupId: number, shares: [number, number, number][]) => ({
      id, groupId, description: 'x', amountCents: shares.reduce((s, x) => s + x[1], 0),
      currency: 'INR', date: '2026-07-21', category: 'general' as const, notes: null,
      isPayment: false, shares: shares.map(([userId, paidCents, owedCents]) => ({ userId, paidCents, owedCents })),
      createdBy: 1, createdAt: '', updatedAt: '',
    });
    const sync = {
      me: { id: 1, name: 'Me', email: null, picture: null, defaultCurrency: 'INR' },
      users: [1, 2, 3].map((id) => ({ id, name: `U${id}`, email: null, picture: null })),
      friendIds: [2, 3],
      groups: [{ id: 7, name: 'G', emoji: 'x', currency: 'INR', createdBy: 1, createdAt: '', memberIds: [1, 2, 3] }],
      expenses: [
        mk(1, 7, [[2, 2000, 1000], [1, 0, 1000]]),   // I owe U2 1000
        mk(2, 7, [[3, 2000, 1000], [1, 0, 1000]]),   // I owe U3 1000
        // I settle my WHOLE net (2000) with U2 alone — like Darshna did:
        mk(3, 7, [[1, 2000, 0], [2, 0, 2000]]),
      ],
      activity: [], syncedAt: '',
    } as never;
    // my net is zero -> I owe nobody and nobody owes me
    expect(myTotalBalance(sync)).toEqual([]);
    expect(friendBalance(sync, 2)).toEqual([]);
    expect(friendBalance(sync, 3)).toEqual([]);
    // the residual debt is now between U2 and U3, not through me
    const transfers = suggestSettlements(groupBalances(sync, 7));
    expect(transfers).toEqual([{ fromUserId: 2, toUserId: 3, cents: 1000, currency: 'INR' }]);
  });
});
