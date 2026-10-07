import { describe, expect, it } from 'vitest';
import { friendBalance, groupBalances, groupSettlements } from './balances';
import { explainDirect, explainFriend, explainGroup, type GroupExplanation } from './explain';
import { pairConstituents } from './settle';
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
  date?: string;
  description?: string;
  shares: ExpenseShare[];
}): Expense {
  const id = idSeq++;
  return {
    id,
    groupId: o.groupId ?? null,
    description: o.description ?? (o.isPayment ? 'Payment' : `Expense ${id}`),
    amountCents: o.shares.reduce((sum, s) => sum + s.owedCents, 0),
    currency: o.currency ?? 'USD',
    date: o.date ?? '2026-01-15',
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
    me: {
      id: 1,
      name: 'Me',
      email: 'me@example.test',
      picture: null,
      defaultCurrency: 'USD',
    },
    users: [],
    friendIds: [],
    groups: [],
    expenses: [],
    activity: [],
    syncedAt: '2026-01-20T00:00:00Z',
    ...overrides,
  };
}

/** `from` owes `to` the amount (to paid, from's share). */
function debt(
  groupId: number | null,
  from: number,
  to: number,
  cents: number,
  currency = 'USD',
): Expense {
  return makeExpense({
    groupId,
    currency,
    shares: [
      { userId: to, paidCents: cents, owedCents: 0 },
      { userId: from, paidCents: 0, owedCents: cents },
    ],
  });
}

/** A random split: one payer covers `total`, shared unevenly among `people`. */
function randomSplit(
  rand: () => number,
  groupId: number | null,
  people: number[],
  currency: string,
): Expense {
  const payer = people[Math.floor(rand() * people.length)];
  const owed = people.map(() => Math.floor(rand() * 5000));
  const total = owed.reduce((a, b) => a + b, 0);
  return makeExpense({
    groupId,
    currency,
    isPayment: rand() < 0.15,
    shares: people.map((userId, i) => ({
      userId,
      paidCents: userId === payer ? total : 0,
      owedCents: owed[i],
    })),
  });
}

/** Checks every internal invariant of one group explanation. */
function checkGroup(sync: SyncData, x: GroupExplanation) {
  // Member nets match the Balances tab, and decompose exactly.
  const nets = groupBalances(sync, x.groupId).filter((b) => b.currency === x.currency);
  expect(x.members.map((m) => [m.userId, m.netCents])).toEqual(
    nets.map((b) => [b.userId, b.netCents]),
  );
  for (const m of x.members) {
    expect(m.paidCents - m.shareCents + m.sentCents - m.receivedCents).toBe(m.netCents);
  }
  // The ledger's per-row effects sum to the focus person's net.
  const focusNet = x.members.find((m) => m.userId === x.focusId)?.netCents ?? 0;
  expect(x.ledger.reduce((s, r) => s + r.focus.netCents, 0)).toBe(focusNet);
  if (x.otherId !== null) {
    const otherNet = x.members.find((m) => m.userId === x.otherId)?.netCents ?? 0;
    expect(x.ledger.reduce((s, r) => s + (r.other?.netCents ?? 0), 0)).toBe(otherNet);
  }
  // Both lines span the same total.
  const debtTotal = x.debtors.reduce((s, d) => s + d.cents, 0);
  expect(debtTotal).toBe(x.totalCents);
  // Steps are exactly the app's suggestions, tiling [0, total) in order...
  expect(x.steps.map((s) => [s.fromUserId, s.toUserId, s.cents])).toEqual(
    groupSettlements(sync, x.groupId)
      .filter((t) => t.currency === x.currency)
      .map((t) => [t.fromUserId, t.toUserId, t.cents]),
  );
  let pos = 0;
  for (const s of x.steps) {
    expect(s.start).toBe(pos);
    expect(s.end - s.start).toBe(s.cents);
    pos = s.end;
    // ...and each one is the overlap of its debtor's and creditor's intervals.
    const d = x.debtors.find((p) => p.userId === s.fromUserId)!;
    const c = x.creditors.find((p) => p.userId === s.toUserId)!;
    expect(s.start).toBe(Math.max(d.start, c.start));
    expect(s.end).toBe(Math.min(d.end, c.end));
  }
  expect(pos).toBe(x.totalCents);
}

describe('explainFriend', () => {
  it('splits a balance into group and direct slices that sum to the headline', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [debt(10, 2, 1, 500), debt(20, 1, 2, 300), debt(null, 2, 1, 100)],
    });
    expect(explainFriend(sync, 2)).toEqual([
      {
        currency: 'USD',
        totalCents: 300,
        slices: [
          { scope: 10, cents: 500 },
          { scope: 20, cents: -300 },
          { scope: null, cents: 100 },
        ],
      },
    ]);
  });

  it('is empty for a zero balance', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2])],
      expenses: [
        debt(10, 2, 1, 500),
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
    expect(explainFriend(sync, 2)).toEqual([]);
    const g = explainGroup(sync, 10, 'USD', 1, 2);
    expect(g.pairCents).toBe(0);
    expect(g.steps).toEqual([]);
    expect(g.ledger).toHaveLength(2);
    const me = g.members.find((m) => m.userId === 1)!;
    expect(me).toMatchObject({
      paidCents: 500,
      shareCents: 0,
      receivedCents: 500,
      netCents: 0,
    });
  });

  it('keeps currencies apart', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2]), makeGroup(20, [1, 2], 'EUR')],
      expenses: [debt(10, 2, 1, 500), debt(20, 1, 2, 700, 'EUR'), debt(null, 2, 1, 50, 'EUR')],
    });
    expect(explainFriend(sync, 2)).toEqual([
      {
        currency: 'EUR',
        totalCents: -650,
        slices: [
          { scope: 20, cents: -700 },
          { scope: null, cents: 50 },
        ],
      },
      { currency: 'USD', totalCents: 500, slices: [{ scope: 10, cents: 500 }] },
    ]);
    expect(explainGroup(sync, 10, 'EUR', 1, 2).ledger).toEqual([]);
    expect(explainGroup(sync, 20, 'EUR', 1, 2).pairCents).toBe(-700);
    expect(explainDirect(sync, 2, 'USD')).toEqual({
      currency: 'USD',
      totalCents: 0,
      items: [],
    });
  });

  it('memoizes per sync snapshot', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2])],
      expenses: [debt(10, 2, 1, 5)],
    });
    expect(explainFriend(sync, 2)).toBe(explainFriend(sync, 2));
    expect(explainGroup(sync, 10, 'USD', 1, 2)).toBe(explainGroup(sync, 10, 'USD', 1, 2));
    expect(explainFriend({ ...sync }, 2)).not.toBe(explainFriend(sync, 2));
  });
});

describe('explainGroup', () => {
  it('traces the sweep: lines by userId, steps as interval overlaps, pair highlighted', () => {
    // Nets: 1:+1000, 2:+900, 3:+800, 4:−1200, 5:−1100, 6:−400.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3, 4, 5, 6])],
      expenses: [
        debt(10, 4, 1, 1000),
        debt(10, 4, 2, 200),
        debt(10, 5, 2, 700),
        debt(10, 5, 3, 400),
        debt(10, 6, 3, 400),
      ],
    });
    const x = explainGroup(sync, 10, 'USD', 1, 4);
    expect(x.totalCents).toBe(2700);
    expect(x.creditors).toEqual([
      { userId: 1, cents: 1000, start: 0, end: 1000 },
      { userId: 2, cents: 900, start: 1000, end: 1900 },
      { userId: 3, cents: 800, start: 1900, end: 2700 },
    ]);
    expect(x.debtors).toEqual([
      { userId: 4, cents: 1200, start: 0, end: 1200 },
      { userId: 5, cents: 1100, start: 1200, end: 2300 },
      { userId: 6, cents: 400, start: 2300, end: 2700 },
    ]);
    expect(x.steps).toEqual([
      {
        index: 0,
        fromUserId: 4,
        toUserId: 1,
        cents: 1000,
        start: 0,
        end: 1000,
        highlighted: true,
      },
      {
        index: 1,
        fromUserId: 4,
        toUserId: 2,
        cents: 200,
        start: 1000,
        end: 1200,
        highlighted: false,
      },
      {
        index: 2,
        fromUserId: 5,
        toUserId: 2,
        cents: 700,
        start: 1200,
        end: 1900,
        highlighted: false,
      },
      {
        index: 3,
        fromUserId: 5,
        toUserId: 3,
        cents: 400,
        start: 1900,
        end: 2300,
        highlighted: false,
      },
      {
        index: 4,
        fromUserId: 6,
        toUserId: 3,
        cents: 400,
        start: 2300,
        end: 2700,
        highlighted: false,
      },
    ]);
    expect(x.pairCents).toBe(1000);
    checkGroup(sync, x);

    // No counterparty: highlight every step touching the focus person.
    const solo = explainGroup(sync, 10, 'USD', 5, null);
    expect(solo.steps.filter((s) => s.highlighted).map((s) => s.index)).toEqual([2, 3]);
    expect(solo.pairCents).toBe(-1100);

    // A pair the sweep doesn't connect: nothing to highlight, zero between them.
    const unlinked = explainGroup(sync, 10, 'USD', 1, 6);
    expect(unlinked.steps.some((s) => s.highlighted)).toBe(false);
    expect(unlinked.pairCents).toBe(0);
  });

  it('shows routed edges even when raw expenses never touched the pair', () => {
    // Raw: 2 owes 3 900, 3 owes me 100. Nets route 100 of 2's debt to me.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3])],
      expenses: [debt(10, 2, 3, 900), debt(10, 3, 1, 100)],
    });
    const x = explainGroup(sync, 10, 'USD', 1, 2);
    expect(x.pairCents).toBe(100);
    expect(x.ledger.every((r) => r.other!.netCents === 0 || r.focus.netCents === 0)).toBe(true);
    checkGroup(sync, x);
  });

  it('splits expenses from settle-up payments in member totals', () => {
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
            { userId: 2, paidCents: 200, owedCents: 0 },
            { userId: 1, paidCents: 0, owedCents: 200 },
          ],
        }),
      ],
    });
    const x = explainGroup(sync, 10, 'USD', 1, 2);
    expect(x.members).toEqual([
      {
        userId: 1,
        paidCents: 1000,
        shareCents: 500,
        sentCents: 0,
        receivedCents: 200,
        netCents: 300,
        current: true,
      },
      {
        userId: 2,
        paidCents: 0,
        shareCents: 500,
        sentCents: 200,
        receivedCents: 0,
        netCents: -300,
        current: true,
      },
    ]);
    expect(x.pairCents).toBe(300);
    checkGroup(sync, x);
  });

  it('includes a departed member who still carries a balance', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 3])],
      expenses: [debt(10, 2, 1, 400), debt(10, 3, 1, 100)],
    });
    const x = explainGroup(sync, 10, 'USD', 1, 2);
    expect(x.members.map((m) => [m.userId, m.netCents, m.current])).toEqual([
      [1, 500, true],
      [2, -400, false],
      [3, -100, true],
    ]);
    expect(x.pairCents).toBe(400);
    expect(explainFriend(sync, 2)[0].slices).toEqual([{ scope: 10, cents: 400 }]);
    checkGroup(sync, x);
  });

  it('orders the ledger newest first', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2])],
      expenses: [
        makeExpense({
          groupId: 10,
          date: '2026-01-01',
          description: 'old',
          shares: [
            { userId: 1, paidCents: 10, owedCents: 0 },
            { userId: 2, paidCents: 0, owedCents: 10 },
          ],
        }),
        makeExpense({
          groupId: 10,
          date: '2026-03-01',
          description: 'new',
          shares: [
            { userId: 1, paidCents: 10, owedCents: 0 },
            { userId: 2, paidCents: 0, owedCents: 10 },
          ],
        }),
      ],
    });
    expect(explainGroup(sync, 10, 'USD', 1, 2).ledger.map((r) => r.expense.description)).toEqual([
      'new',
      'old',
    ]);
  });
});

describe('explainDirect', () => {
  it('lists direct expenses and payments with signed effects (direct-only balance)', () => {
    const lunch = makeExpense({
      shares: [
        { userId: 1, paidCents: 2000, owedCents: 1000 },
        { userId: 2, paidCents: 0, owedCents: 1000 },
      ],
    });
    const taxi = debt(null, 1, 2, 300);
    const payback = makeExpense({
      isPayment: true,
      shares: [
        { userId: 2, paidCents: 400, owedCents: 0 },
        { userId: 1, paidCents: 0, owedCents: 400 },
      ],
    });
    const unrelated = debt(null, 3, 1, 999);
    const sync = makeSync({ expenses: [lunch, taxi, payback, unrelated] });
    const x = explainDirect(sync, 2, 'USD');
    expect(x.totalCents).toBe(300);
    expect(
      x.items.map((i) => (i.kind === 'expense' ? [i.expense.id, i.cents] : null)).sort(),
    ).toEqual(
      [
        [lunch.id, 1000],
        [taxi.id, -300],
        [payback.id, -400],
      ].sort(),
    );
    expect(explainFriend(sync, 2)).toEqual([
      {
        currency: 'USD',
        totalCents: 300,
        slices: [{ scope: null, cents: 300 }],
      },
    ]);
  });

  it('carries legacy group edges in a non-group currency', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2], 'EUR')],
      expenses: [debt(10, 2, 1, 400, 'USD'), debt(null, 1, 2, 100, 'USD')],
    });
    const x = explainDirect(sync, 2, 'USD');
    expect(x.totalCents).toBe(300);
    expect(x.items[0]).toEqual({ kind: 'group', groupId: 10, cents: 400 });
    expect(pairConstituents(sync, 2, 'USD')).toEqual([{ scope: null, cents: 300 }]);
  });
});

describe('PROPERTY: explanations reconcile with what the app shows', () => {
  it('slices sum to friendBalance; each slice equals its scope trace', () => {
    const rand = lcg(20261007);
    const currencies = ['USD', 'EUR'];
    for (let round = 0; round < 80; round++) {
      const groups = [
        makeGroup(10, [1, 2, 3, 4]),
        makeGroup(20, [1, 2, 5], 'EUR'),
        // Departed member 4 (has history but left).
        makeGroup(30, [1, 3, 5]),
      ];
      const expenses: Expense[] = [];
      const n = 3 + Math.floor(rand() * 10);
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.25) {
          const friend = 2 + Math.floor(rand() * 4);
          expenses.push(randomSplit(rand, null, [1, friend], currencies[Math.floor(rand() * 2)]));
          continue;
        }
        const g = groups[Math.floor(rand() * groups.length)];
        const people = g.id === 30 ? [1, 3, 4, 5] : g.memberIds;
        // Mostly in the group's currency; occasionally a legacy other-currency row.
        const currency = rand() < 0.85 ? g.currency : currencies.find((c) => c !== g.currency)!;
        const subset = people.filter(() => rand() < 0.75);
        if (subset.length < 2) continue;
        expenses.push(randomSplit(rand, g.id, subset, currency));
      }
      const sync = makeSync({ groups, expenses });

      for (const friend of [2, 3, 4, 5]) {
        const shown = friendBalance(sync, friend);
        const explained = explainFriend(sync, friend);
        expect(explained.map((e) => [e.currency, e.totalCents])).toEqual(
          shown.map((b) => [b.currency, b.netCents]),
        );
        for (const e of explained) {
          expect(e.slices.reduce((s, c) => s + c.cents, 0)).toBe(e.totalCents);
          for (const slice of e.slices) {
            if (slice.scope === null) {
              expect(explainDirect(sync, friend, e.currency).totalCents).toBe(slice.cents);
            } else {
              const x = explainGroup(sync, slice.scope, e.currency, 1, friend);
              expect(x.pairCents).toBe(slice.cents);
              expect(x.steps.some((s) => s.highlighted)).toBe(true);
            }
          }
          if (!e.slices.some((s) => s.scope === null)) {
            expect(explainDirect(sync, friend, e.currency).totalCents).toBe(0);
          }
        }
      }
      for (const g of groups) {
        for (const currency of currencies) {
          checkGroup(sync, explainGroup(sync, g.id, currency, 1, 2));
          checkGroup(sync, explainGroup(sync, g.id, currency, 3, null));
        }
      }
    }
  });
});
