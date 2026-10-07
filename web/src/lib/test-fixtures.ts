import type { Expense, SyncData, User } from './types';

/** Shared test dataset: me (1), friends Ben (2) & Cara (3), group 10 = {1,2,4}. Asha (4) is a group member, not a friend. */
export const user = (id: number, name: string): User => ({ id, name, email: null, picture: null });

export function makeSync(over: Partial<SyncData> = {}): SyncData {
  return {
    me: { ...user(1, 'Me'), defaultCurrency: 'USD' },
    users: [user(1, 'Me'), user(2, 'Ben'), user(3, 'Cara'), user(4, 'Asha')],
    friendIds: [2, 3],
    groups: [
      {
        id: 10,
        name: 'Flat',
        emoji: '🏠',
        currency: 'EUR',
        createdBy: 1,
        createdAt: '2026-01-01T00:00:00Z',
        memberIds: [1, 2, 4],
      },
    ],
    expenses: [],
    activity: [],
    syncedAt: '',
    ...over,
  };
}

export function makeExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 100,
    groupId: 10,
    description: 'Groceries',
    amountCents: 3000,
    currency: 'EUR',
    date: '2026-09-01',
    category: 'groceries',
    notes: 'Weekly shop',
    isPayment: false,
    shares: [
      { userId: 1, paidCents: 3000, owedCents: 1000 },
      { userId: 2, paidCents: 0, owedCents: 1000 },
      { userId: 4, paidCents: 0, owedCents: 1000 },
    ],
    createdBy: 1,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/** Sync where Asha (4) has left group 10. */
export const ashaLeft = (): SyncData => {
  const s = makeSync();
  return { ...s, groups: s.groups.map((g) => ({ ...g, memberIds: [1, 2] })) };
};
