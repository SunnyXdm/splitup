import { describe, expect, it } from 'vitest';
import {
  archivedGroups,
  isArchived,
  myOpenGroupBalances,
  partitionGroups,
  withGroupArchived,
} from './archive';
import { myTotalBalance } from './balances';
import { makeExpense, makeSync } from './test-fixtures';
import type { Group } from './types';

const group = (id: number, archivedAt?: string | null): Group => ({
  id,
  name: `G${id}`,
  emoji: '🧾',
  currency: 'EUR',
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00Z',
  memberIds: [1, 2],
  ...(archivedAt === undefined ? {} : { archivedAt }),
});

describe('isArchived', () => {
  it('treats missing and null archivedAt as not archived', () => {
    expect(isArchived(group(1))).toBe(false);
    expect(isArchived(group(1, null))).toBe(false);
    expect(isArchived(group(1, '2026-10-01T00:00:00Z'))).toBe(true);
  });
});

describe('partitionGroups', () => {
  it('splits by archivedAt and keeps the original order', () => {
    const groups = [
      group(1),
      group(2, '2026-10-01T00:00:00Z'),
      group(3, null),
      group(4, '2026-09-01T00:00:00Z'),
    ];
    const { active, archived } = partitionGroups(groups);
    expect(active.map((g) => g.id)).toEqual([1, 3]);
    expect(archived.map((g) => g.id)).toEqual([2, 4]);
  });

  it('handles empty input', () => {
    expect(partitionGroups([])).toEqual({ active: [], archived: [] });
  });
});

describe('archivedGroups', () => {
  it('lists the most recently archived first', () => {
    const groups = [
      group(1, '2026-09-01T00:00:00Z'),
      group(2),
      group(3, '2026-10-01T00:00:00Z'),
    ];
    expect(archivedGroups(groups).map((g) => g.id)).toEqual([3, 1]);
  });
});

describe('withGroupArchived', () => {
  it('sets and clears archivedAt on one group only', () => {
    const sync = makeSync({ groups: [group(10), group(11)] });
    const archived = withGroupArchived(sync, 10, '2026-10-07T00:00:00Z');
    expect(archived.groups.find((g) => g.id === 10)?.archivedAt).toBe('2026-10-07T00:00:00Z');
    expect(archived.groups.find((g) => g.id === 11)).toBe(sync.groups[1]);
    const back = withGroupArchived(archived, 10, null);
    expect(back.groups.find((g) => g.id === 10)?.archivedAt).toBeNull();
  });

  it('is a no-op for an unknown group', () => {
    const sync = makeSync();
    expect(withGroupArchived(sync, 999, '2026-10-07T00:00:00Z')).toBe(sync);
  });
});

describe('archived groups and balances', () => {
  it('still count toward my totals and open-balance hint', () => {
    const base = makeSync({ expenses: [makeExpense()] });
    const archived = withGroupArchived(base, 10, '2026-10-07T00:00:00Z');
    expect(myTotalBalance(archived)).toEqual(myTotalBalance(base));
    expect(myOpenGroupBalances(archived, 10)).toEqual([
      { userId: 1, netCents: 2000, currency: 'EUR' },
    ]);
  });

  it('reports no open balance once settled', () => {
    const sync = makeSync();
    expect(myOpenGroupBalances(sync, 10)).toEqual([]);
  });
});
