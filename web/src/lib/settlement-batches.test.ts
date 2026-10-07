import { describe, expect, it } from 'vitest';
import {
  batchScopeHint,
  historyEntries,
  isBatchParticipant,
  methodLabel,
  netCash,
  paymentRowAction,
} from './settlement-batches';
import type { Expense, SettlementBatch } from './types';

const ME = 1;
const DEV = 2;

const payment = (
  id: number,
  groupId: number | null,
  payerId: number,
  recipientId: number,
  amountCents: number,
  settlementBatchId: number | null | undefined,
  date = '2026-10-05',
): Expense => ({
  id,
  groupId,
  description: 'Payment',
  amountCents,
  currency: 'INR',
  date,
  category: 'general',
  notes: null,
  isPayment: true,
  shares: [
    { userId: payerId, paidCents: amountCents, owedCents: 0 },
    { userId: recipientId, paidCents: 0, owedCents: amountCents },
  ],
  createdBy: ME,
  createdAt: `${date}T10:00:00.000Z`,
  updatedAt: `${date}T10:00:00.000Z`,
  ...(settlementBatchId === undefined ? {} : { settlementBatchId }),
});

const expense = (id: number, date: string): Expense => ({
  ...payment(id, 7, ME, DEV, 5000, null, date),
  description: 'Dinner',
  isPayment: false,
});

const batch = (id: number, rows: number[], date = '2026-10-05'): SettlementBatch => ({
  id,
  payerId: ME,
  payeeId: DEV,
  amountCents: 120_000,
  currency: 'INR',
  date,
  method: 'upi',
  reference: null,
  note: null,
  createdBy: ME,
  createdAt: `${date}T10:00:00.000Z`,
  rows,
});

describe('historyEntries', () => {
  const rows = [
    payment(10, 7, ME, DEV, 100_000, 3),
    payment(11, 8, ME, DEV, 40_000, 3),
    payment(12, null, DEV, ME, 20_000, 3),
  ];

  it('collapses every row of a known batch into one entry', () => {
    const entries = historyEntries(
      [rows[2], expense(20, '2026-10-01'), rows[0], rows[1]],
      [batch(3, [10, 11, 12])],
      { collapse: true },
    );
    expect(entries.map((e) => e.key)).toEqual(['b3', 'e20']);
    const first = entries[0];
    expect(first.kind).toBe('batch');
    if (first.kind === 'batch') expect(first.rows.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it('keeps rows individual without collapse, for unknown batches and legacy rows', () => {
    expect(
      historyEntries(rows, [batch(3, [10, 11, 12])], { collapse: false }).map((e) => e.key),
    ).toEqual(['e12', 'e11', 'e10']);
    // Old cache: no settlementBatches at all.
    expect(
      historyEntries(rows, undefined, { collapse: true }).every((e) => e.kind === 'expense'),
    ).toBe(true);
    // Legacy payment rows without a batch id (field absent or null).
    const legacy = [payment(30, 7, ME, DEV, 500, undefined), payment(31, 7, ME, DEV, 500, null)];
    expect(historyEntries(legacy, [batch(3, [10])], { collapse: true }).map((e) => e.key)).toEqual([
      'e31',
      'e30',
    ]);
  });

  it('sorts batches among expenses by date, newest first', () => {
    const entries = historyEntries(
      [expense(1, '2026-09-01'), rows[0], expense(2, '2026-10-06')],
      [batch(3, [10], '2026-10-05')],
      { collapse: true },
    );
    expect(entries.map((e) => e.key)).toEqual(['e2', 'b3', 'e1']);
  });

  it('separates two batches', () => {
    const entries = historyEntries(
      [
        payment(40, 7, ME, DEV, 1, 4),
        payment(41, 7, ME, DEV, 1, 5),
        payment(42, null, ME, DEV, 1, 4),
      ],
      [batch(4, [40, 42], '2026-10-01'), batch(5, [41], '2026-10-02')],
      { collapse: true },
    );
    expect(entries.map((e) => e.key)).toEqual(['b5', 'b4']);
  });
});

describe('batchScopeHint', () => {
  it('describes multi-scope batches only', () => {
    expect(batchScopeHint([payment(1, 7, ME, DEV, 1, 3)])).toBeNull();
    expect(batchScopeHint([payment(1, 7, ME, DEV, 1, 3), payment(2, 8, ME, DEV, 1, 3)])).toBe(
      'Split across 2 groups',
    );
    expect(batchScopeHint([payment(1, 7, ME, DEV, 1, 3), payment(2, null, ME, DEV, 1, 3)])).toBe(
      'Split across 1 group and direct',
    );
  });
});

describe('netCash', () => {
  it('nets counter rows into one cash direction', () => {
    expect(
      netCash(
        [
          { payerId: ME, recipientId: DEV, amountCents: 100 },
          { payerId: DEV, recipientId: ME, amountCents: 30 },
        ],
        ME,
        DEV,
      ),
    ).toEqual({ payerId: ME, payeeId: DEV, amountCents: 70 });
    expect(netCash([{ payerId: DEV, recipientId: ME, amountCents: 50 }], ME, DEV)).toEqual({
      payerId: DEV,
      payeeId: ME,
      amountCents: 50,
    });
  });

  it('labels methods', () => {
    expect(methodLabel('upi')).toBe('UPI');
    expect(methodLabel(null)).toBeNull();
  });
});

describe('settle-up permissions', () => {
  const b = {
    id: 7,
    payerId: 1,
    payeeId: 2,
    amountCents: 100,
    currency: 'INR',
    date: '2026-10-01',
    method: null,
    reference: null,
    note: null,
    createdBy: 2,
    createdAt: '2026-10-01T00:00:00Z',
    rows: [70],
  } satisfies SettlementBatch;
  const row = (settlementBatchId: number | null) =>
    ({ id: 70, isPayment: true, settlementBatchId }) as Expense;

  it('only the payer, payee or recorder may undo', () => {
    expect(isBatchParticipant(b, 1)).toBe(true);
    expect(isBatchParticipant(b, 2)).toBe(true);
    expect(isBatchParticipant({ ...b, createdBy: 3 }, 3)).toBe(true);
    expect(isBatchParticipant(b, 4)).toBe(false);
  });

  it('never offers plain delete for a settle-up row', () => {
    const known = new Map([[7, b]]);
    expect(paymentRowAction(row(7), known)).toBe('receipt');
    expect(paymentRowAction(row(7), new Map())).toBe('none');
    expect(paymentRowAction(row(null), known)).toBe('delete');
  });
});
