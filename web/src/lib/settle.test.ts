import { describe, expect, it } from 'vitest';
import { friendBalance, groupBalances, myTotalBalance, suggestSettlements } from './balances';
import { apportionSettle, pairConstituents, settlementWatermark, type SettleRow } from './settle';
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

/** paid/owed pair helper: `from` owes `to` the amount, inside a group. */
function debt(groupId: number, from: number, to: number, cents: number, currency = 'USD'): Expense {
  return makeExpense({
    groupId,
    currency,
    shares: [
      { userId: to, paidCents: cents, owedCents: 0 },
      { userId: from, paidCents: 0, owedCents: cents },
    ],
  });
}

/** Applies settle rows to a sync snapshot as recorded payment expenses. */
function applyRows(sync: SyncData, rows: SettleRow[], currency = 'USD'): SyncData {
  const payments = rows.map((r) =>
    makeExpense({
      groupId: r.groupId,
      currency,
      isPayment: true,
      shares: [
        { userId: r.payerId, paidCents: r.amountCents, owedCents: 0 },
        { userId: r.recipientId, paidCents: 0, owedCents: r.amountCents },
      ],
    }),
  );
  return { ...sync, expenses: [...sync.expenses, ...payments] };
}

const balanceWith = (sync: SyncData, friendId: number, currency = 'USD'): number =>
  friendBalance(sync, friendId).find((b) => b.currency === currency)?.netCents ?? 0;

describe('pairConstituents', () => {
  it('sums to the friend balance across groups and direct expenses', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [
        debt(10, 2, 1, 500),
        debt(20, 1, 2, 300),
        makeExpense({
          shares: [
            { userId: 1, paidCents: 200, owedCents: 100 },
            { userId: 2, paidCents: 0, owedCents: 100 },
          ],
        }),
      ],
    });
    const constituents = pairConstituents(sync, 2, 'USD');
    expect(constituents).toEqual([
      { scope: 10, cents: 500 },
      { scope: 20, cents: -300 },
      { scope: null, cents: 100 },
    ]);
    expect(constituents.reduce((sum, c) => sum + c.cents, 0)).toBe(balanceWith(sync, 2));
  });

  it('only reports edges routed to the pair, not raw pairwise debts', () => {
    // 2 owes the group pool, but greedy routes 2's debt to 3 (larger creditor),
    // so the me<->2 constituent list must be empty for that group.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3])],
      expenses: [debt(10, 2, 3, 900), debt(10, 3, 1, 100)],
    });
    const routed = suggestSettlements(groupBalances(sync, 10));
    expect(routed).toEqual([
      { fromUserId: 2, toUserId: 3, cents: 800, currency: 'USD' },
      { fromUserId: 2, toUserId: 1, cents: 100, currency: 'USD' },
    ]);
    expect(pairConstituents(sync, 2, 'USD')).toEqual([{ scope: 10, cents: 100 }]);
  });

  it('keeps a departed member’s edge group-scoped (server accepts it via share history)', () => {
    // User 2 has left group 10 but still carries a nonzero net there. Folding
    // this to direct would recreate the routing-flip bug; the group row keeps
    // the ledger settling in place.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 3])],
      expenses: [debt(10, 2, 1, 400)],
    });
    expect(pairConstituents(sync, 2, 'USD')).toEqual([{ scope: 10, cents: 400 }]);
  });

  it('folds an edge in a non-group currency into the direct slice', () => {
    // Legacy shape: a USD edge inside an EUR group can't take a payment row.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2], 'EUR')],
      expenses: [debt(10, 2, 1, 400, 'USD')],
    });
    expect(pairConstituents(sync, 2, 'USD')).toEqual([{ scope: null, cents: 400 }]);
  });

  it('isolates currencies', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2]), makeGroup(20, [1, 2], 'EUR')],
      expenses: [debt(10, 2, 1, 500), debt(20, 2, 1, 700, 'EUR')],
    });
    expect(pairConstituents(sync, 2, 'USD')).toEqual([{ scope: 10, cents: 500 }]);
    expect(pairConstituents(sync, 2, 'EUR')).toEqual([{ scope: 20, cents: 700 }]);
  });
});

describe('apportionSettle', () => {
  const ME = 1;
  const FRIEND = 2;

  it('settles a single group edge with a single group payment (#69 shape)', () => {
    const rows = apportionSettle([{ scope: 10, cents: 60584 }], 60584, 'they_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 10, payerId: FRIEND, recipientId: ME, amountCents: 60584, counter: false },
    ]);
  });

  it('emits a counter row for opposing edges on a full settle (#65 shape)', () => {
    // Friend owes me 693.16 in group 10, I owe friend 446.87 in group 20;
    // net 246.29 changes hands but both groups must settle.
    const constituents = [
      { scope: 10, cents: 69316 },
      { scope: 20, cents: -44687 },
    ];
    const rows = apportionSettle(constituents, 24629, 'they_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 10, payerId: FRIEND, recipientId: ME, amountCents: 69316, counter: false },
      { groupId: 20, payerId: ME, recipientId: FRIEND, amountCents: 44687, counter: true },
    ]);
  });

  it('decomposes a three-group net (#66 shape)', () => {
    const constituents = [
      { scope: 4, cents: 26675 },
      { scope: 7, cents: 26125 },
      { scope: 2, cents: -46951 },
    ];
    const rows = apportionSettle(constituents, 5849, 'they_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 4, payerId: FRIEND, recipientId: ME, amountCents: 26675, counter: false },
      { groupId: 7, payerId: FRIEND, recipientId: ME, amountCents: 26125, counter: false },
      { groupId: 2, payerId: ME, recipientId: FRIEND, amountCents: 46951, counter: true },
    ]);
  });

  it('allocates partials largest-first without counter rows', () => {
    const constituents = [
      { scope: 10, cents: 500 },
      { scope: 20, cents: 900 },
      { scope: 30, cents: -200 },
    ];
    // net = 1200; pay 1000 of it
    const rows = apportionSettle(constituents, 1000, 'they_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 20, payerId: FRIEND, recipientId: ME, amountCents: 900, counter: false },
      { groupId: 10, payerId: FRIEND, recipientId: ME, amountCents: 100, counter: false },
    ]);
  });

  it('breaks partial-allocation ties direct-first, then lower groupId', () => {
    const constituents = [
      { scope: 20, cents: 300 },
      { scope: null, cents: 300 },
      { scope: 10, cents: 300 },
    ];
    const rows = apportionSettle(constituents, 500, 'they_paid', ME, FRIEND);
    expect(rows.map((r) => [r.groupId, r.amountCents])).toEqual([
      [null, 300],
      [10, 200],
    ]);
  });

  it('records overpayment excess as a direct credit', () => {
    const rows = apportionSettle([{ scope: 10, cents: 500 }], 800, 'they_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 10, payerId: FRIEND, recipientId: ME, amountCents: 500, counter: false },
      { groupId: null, payerId: FRIEND, recipientId: ME, amountCents: 300, counter: false },
    ]);
  });

  it('merges overpay excess into an existing direct slice (never two direct rows)', () => {
    // The server rejects two same-direction direct rows, so the excess must
    // fold into the direct constituent.
    const rows = apportionSettle(
      [
        { scope: 10, cents: 500 },
        { scope: null, cents: 200 },
      ],
      900,
      'they_paid',
      ME,
      FRIEND,
    );
    expect(rows).toEqual([
      { groupId: 10, payerId: FRIEND, recipientId: ME, amountCents: 500, counter: false },
      { groupId: null, payerId: FRIEND, recipientId: ME, amountCents: 400, counter: false },
    ]);
    expect(rows.filter((r) => r.groupId === null)).toHaveLength(1);

    const mirrored = apportionSettle(
      [
        { scope: 10, cents: -500 },
        { scope: null, cents: -200 },
      ],
      900,
      'i_paid',
      ME,
      FRIEND,
    );
    expect(mirrored).toEqual([
      { groupId: 10, payerId: ME, recipientId: FRIEND, amountCents: 500, counter: false },
      { groupId: null, payerId: ME, recipientId: FRIEND, amountCents: 400, counter: false },
    ]);
  });

  it('records a contrarian payment as one plain direct row', () => {
    // Friend owes me, but I record that I paid them anyway.
    const rows = apportionSettle([{ scope: 10, cents: 500 }], 400, 'i_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: null, payerId: ME, recipientId: FRIEND, amountCents: 400, counter: false },
    ]);
  });

  it('mirrors correctly for the i_paid direction', () => {
    const rows = apportionSettle([{ scope: 10, cents: -500 }], 500, 'i_paid', ME, FRIEND);
    expect(rows).toEqual([
      { groupId: 10, payerId: ME, recipientId: FRIEND, amountCents: 500, counter: false },
    ]);
  });
});

describe('settlementWatermark', () => {
  it('fingerprints shared-group, friend-share, and direct expenses', () => {
    const shared = debt(10, 2, 1, 500);
    const foldSource = debt(20, 2, 3, 300); // friend holds a share, I'm the only pair member
    const unrelated = debt(30, 3, 1, 100); // my group, no friend involvement
    const direct = makeExpense({
      shares: [
        { userId: 1, paidCents: 200, owedCents: 100 },
        { userId: 2, paidCents: 0, owedCents: 100 },
      ],
    });
    shared.updatedAt = '2026-02-01T00:00:00Z';
    foldSource.updatedAt = '2026-03-01T00:00:00Z';
    unrelated.updatedAt = '2026-04-01T00:00:00Z';
    direct.updatedAt = '2026-01-01T00:00:00Z';
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2]), makeGroup(20, [1, 3]), makeGroup(30, [1, 3])],
      expenses: [shared, foldSource, unrelated, direct],
    });
    // Group 20 counts (friend's share makes its routing pair-relevant);
    // group 30 does not; the unrelated max must not leak in.
    expect(settlementWatermark(sync, 2)).toEqual({
      watermark: '2026-03-01T00:00:00Z',
      watermarkCount: 3,
    });
  });

  it('returns an empty fingerprint when the pair has no expenses', () => {
    const sync = makeSync({ groups: [makeGroup(10, [1, 2])] });
    expect(settlementWatermark(sync, 2)).toEqual({ watermark: '', watermarkCount: 0 });
  });
});

describe('settle end-to-end', () => {
  it('a full apportioned settle zeroes the friend balance AND every group edge', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [debt(10, 2, 1, 69316), debt(20, 1, 2, 44687)],
    });
    const net = balanceWith(sync, 2);
    expect(net).toBe(24629);
    const rows = apportionSettle(pairConstituents(sync, 2, 'USD'), net, 'they_paid', 1, 2);
    const after = applyRows(sync, rows);
    expect(balanceWith(after, 2)).toBe(0);
    for (const g of after.groups) {
      const edges = suggestSettlements(groupBalances(after, g.id)).filter(
        (t) =>
          (t.fromUserId === 1 && t.toUserId === 2) || (t.fromUserId === 2 && t.toUserId === 1),
      );
      expect(edges).toEqual([]);
    }
    expect(myTotalBalance(after)).toEqual([]);
  });

  it('REGRESSION: settled balances stay settled when later expenses re-route a group (the cross-scope flip)', () => {
    // Me(1), friend(2), third member(3): friend owes me via group 10's routing.
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [debt(10, 2, 1, 60584), debt(20, 1, 2, 47908)],
    });
    const net = balanceWith(sync, 2);
    const rows = apportionSettle(pairConstituents(sync, 2, 'USD'), net, 'they_paid', 1, 2);
    const settled = applyRows(sync, rows);
    expect(balanceWith(settled, 2)).toBe(0);

    // A new expense between OTHER members re-routes group 10's settlement
    // graph. With the old single non-group payment this flipped the pair's
    // balance; with per-scope rows the pair must stay settled.
    const later = {
      ...settled,
      expenses: [...settled.expenses, debt(10, 3, 1, 20000)],
    };
    expect(balanceWith(later, 2)).toBe(0);
    // And my total reflects only the genuinely new debt.
    expect(myTotalBalance(later)).toEqual([{ currency: 'USD', netCents: 20000 }]);
  });

  it('CHARACTERIZATION: the old single non-group payment DID flip on re-route', () => {
    const sync = makeSync({
      groups: [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2])],
      expenses: [debt(10, 2, 1, 60584), debt(20, 1, 2, 47908)],
    });
    const net = balanceWith(sync, 2);
    // The pre-fix behavior: one non-group payment for the cross-group net.
    const oldStyle = applyRows(sync, [
      { groupId: null, payerId: 2, recipientId: 1, amountCents: net, counter: false },
    ]);
    expect(balanceWith(oldStyle, 2)).toBe(0);
    // Me borrowing from user 3 makes 3 the group's dominant creditor, so the
    // greedy router sends friend 2's debt to 3 instead of me — the pair edge
    // disappears while the fixed non-group counterweight stays.
    const later = {
      ...oldStyle,
      expenses: [...oldStyle.expenses, debt(10, 1, 3, 70000)],
    };
    // Group 10's routing moved off the pair, but the fixed counterweight
    // remains: the "settled" balance resurfaces. This documents the bug the
    // apportioned settle fixes; if it ever fails, the engine's semantics
    // changed and the migration assumptions need re-checking.
    expect(balanceWith(later, 2)).not.toBe(0);
  });

  it('PROPERTY: totals equal the sum of friend balances, and full settles always zero the pair', () => {
    const rand = lcg(20260817);
    for (let round = 0; round < 60; round++) {
      const users = [1, 2, 3, 4];
      const groups = [makeGroup(10, [1, 2, 3]), makeGroup(20, [1, 2, 4]), makeGroup(30, [1, 2])];
      const expenses: Expense[] = [];
      const n = 2 + Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) {
        const g = groups[Math.floor(rand() * groups.length)];
        const members = g.memberIds;
        const from = members[Math.floor(rand() * members.length)];
        let to = members[Math.floor(rand() * members.length)];
        if (to === from) to = members[(members.indexOf(from) + 1) % members.length];
        expenses.push(debt(g.id, from, to, 1 + Math.floor(rand() * 99999)));
      }
      let sync = makeSync({ groups, expenses });

      // P1: total balance equals the sum over every other user of friendBalance.
      const total = myTotalBalance(sync).find((b) => b.currency === 'USD')?.netCents ?? 0;
      const sum = users
        .filter((u) => u !== 1)
        .reduce((acc, u) => acc + balanceWith(sync, u), 0);
      expect(total).toBe(sum);

      // P3: a full apportioned settle with a random friend zeroes that pair
      // everywhere, and leaves everyone's totals consistent (P1 again).
      const friend = 2 + Math.floor(rand() * 3);
      const net = balanceWith(sync, friend);
      if (net !== 0) {
        const rows = apportionSettle(
          pairConstituents(sync, friend, 'USD'),
          Math.abs(net),
          net > 0 ? 'they_paid' : 'i_paid',
          1,
          friend,
        );
        sync = applyRows(sync, rows);
        expect(balanceWith(sync, friend)).toBe(0);
        for (const g of sync.groups) {
          const edges = suggestSettlements(groupBalances(sync, g.id)).filter(
            (t) =>
              (t.fromUserId === 1 && t.toUserId === friend) ||
              (t.fromUserId === friend && t.toUserId === 1),
          );
          expect(edges).toEqual([]);
        }
        const totalAfter = myTotalBalance(sync).find((b) => b.currency === 'USD')?.netCents ?? 0;
        const sumAfter = users
          .filter((u) => u !== 1)
          .reduce((acc, u) => acc + balanceWith(sync, u), 0);
        expect(totalAfter).toBe(sumAfter);
      }
    }
  });

  it('PROPERTY: acting on every suggestion plus residues zeroes the whole world', () => {
    const rand = lcg(777);
    for (let round = 0; round < 40; round++) {
      const groups = [makeGroup(10, [1, 2, 3, 4]), makeGroup(20, [2, 3])];
      const expenses: Expense[] = [];
      const n = 2 + Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) {
        const g = groups[Math.floor(rand() * groups.length)];
        const members = g.memberIds;
        const from = members[Math.floor(rand() * members.length)];
        let to = members[Math.floor(rand() * members.length)];
        if (to === from) to = members[(members.indexOf(from) + 1) % members.length];
        expenses.push(debt(g.id, from, to, 1 + Math.floor(rand() * 9999)));
      }
      let sync = makeSync({ groups, expenses });

      // Record every routed edge as a payment inside its own group.
      const payments: SettleRow[] = [];
      for (const g of sync.groups) {
        for (const t of suggestSettlements(groupBalances(sync, g.id))) {
          payments.push({
            groupId: g.id,
            payerId: t.fromUserId,
            recipientId: t.toUserId,
            amountCents: t.cents,
            counter: false,
          });
        }
      }
      sync = applyRows(sync, payments);

      for (const g of sync.groups) {
        for (const b of groupBalances(sync, g.id)) expect(b.netCents).toBe(0);
      }
      expect(myTotalBalance(sync)).toEqual([]);
      for (const friend of [2, 3, 4]) expect(balanceWith(sync, friend)).toBe(0);
    }
  });
});
