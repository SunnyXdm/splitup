import { describe, expect, it } from 'vitest';
import { buildGroupCsv } from './export-csv';
import type { SyncData } from './types';

const sync = {
  me: { id: 1, name: 'Alice', email: null, picture: null, defaultCurrency: 'INR' },
  users: [
    { id: 1, name: 'Alice', email: null, picture: null },
    { id: 2, name: 'Bob "B"', email: null, picture: null },
  ],
  friendIds: [2],
  groups: [
    { id: 9, name: 'Trip', emoji: 'x', currency: 'INR', createdBy: 1, createdAt: '', memberIds: [1, 2] },
  ],
  expenses: [
    {
      id: 5, groupId: 9, description: 'Chai, snacks', amountCents: 30000, currency: 'INR',
      date: '2026-07-21', category: 'food', notes: null, isPayment: false,
      shares: [
        { userId: 1, paidCents: 30000, owedCents: 15000 },
        { userId: 2, paidCents: 0, owedCents: 15000 },
      ],
      createdBy: 1, createdAt: '', updatedAt: '',
    },
    {
      id: 6, groupId: 9, description: 'Payment', amountCents: 15000, currency: 'INR',
      date: '2026-07-22', category: 'general', notes: null, isPayment: true,
      shares: [
        { userId: 2, paidCents: 15000, owedCents: 0 },
        { userId: 1, paidCents: 0, owedCents: 15000 },
      ],
      createdBy: 2, createdAt: '', updatedAt: '',
    },
  ],
  activity: [],
  syncedAt: '',
} as unknown as SyncData;

describe('buildGroupCsv', () => {
  it('emits header, nets per member, payments, and CSV escaping', () => {
    const lines = buildGroupCsv(sync, 9).trimEnd().split('\n');
    expect(lines[0]).toBe('Date,Description,Category,Cost,Currency,Alice,"Bob ""B"""');
    expect(lines[1]).toBe('2026-07-21,"Chai, snacks",Food & drink,300.00,INR,150.00,-150.00');
    expect(lines[2]).toBe('2026-07-22,Payment,Payment,150.00,INR,-150.00,150.00');
  });
});
