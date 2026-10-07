import { describe, expect, it } from 'vitest';
import { formatMoney } from './money';
import { describeRevisions, diffSnapshots, joinNames, sameSnapshot } from './revisions';
import type { ExpenseRevision, ExpenseSnapshot } from './types';

const NAMES: Record<number, string> = { 1: 'You', 2: 'Asha', 3: 'Bilal' };
const nameOf = (id: number) => NAMES[id] ?? 'Someone';
const inr = (cents: number) => formatMoney(cents, 'INR');

const base: ExpenseSnapshot = {
  description: 'Dinner',
  amountCents: 40_000,
  currency: 'INR',
  date: '2026-10-01',
  category: 'food',
  notes: null,
  groupId: 10,
  isPayment: false,
  shares: [
    { userId: 1, paidCents: 40_000, owedCents: 20_000 },
    { userId: 2, paidCents: 0, owedCents: 20_000 },
  ],
};

const rev = (
  revision: number,
  action: ExpenseRevision['action'],
  actorId: number,
  snapshot: ExpenseSnapshot,
): ExpenseRevision => ({
  revision,
  action,
  actorId,
  createdAt: `2026-10-0${revision}T10:00:00.000Z`,
  snapshot,
});

describe('diffSnapshots', () => {
  it('is empty for identical snapshots', () => {
    expect(diffSnapshots(base, { ...base, shares: [...base.shares].reverse() }, nameOf)).toEqual({
      parts: [],
      splitLines: [],
    });
  });

  it('words amount, split and date changes in reading order', () => {
    const next: ExpenseSnapshot = {
      ...base,
      amountCents: 45_000,
      date: '2026-10-02',
      shares: [
        { userId: 1, paidCents: 45_000, owedCents: 22_500 },
        { userId: 2, paidCents: 0, owedCents: 22_500 },
      ],
    };
    const diff = diffSnapshots(base, next, nameOf);
    expect(diff.parts).toEqual([
      `amount ${inr(40_000)} → ${inr(45_000)}`,
      'split',
      'date Oct 1, 2026 → Oct 2, 2026',
    ]);
    expect(diff.splitLines).toEqual([
      `You ${inr(20_000)} → ${inr(22_500)}`,
      `Asha ${inr(20_000)} → ${inr(22_500)}`,
    ]);
  });

  it('names people added to and removed from the split, and payer changes', () => {
    const next: ExpenseSnapshot = {
      ...base,
      shares: [
        { userId: 1, paidCents: 0, owedCents: 20_000 },
        { userId: 3, paidCents: 40_000, owedCents: 20_000 },
      ],
    };
    const diff = diffSnapshots(base, next, nameOf);
    expect(diff.parts).toEqual(['paid by You → Bilal', 'split']);
    expect(diff.splitLines).toEqual([
      `Asha removed (was ${inr(20_000)})`,
      `Bilal added (${inr(20_000)})`,
    ]);
  });

  it('lists several payers with their amounts', () => {
    const next: ExpenseSnapshot = {
      ...base,
      shares: [
        { userId: 1, paidCents: 30_000, owedCents: 20_000 },
        { userId: 2, paidCents: 10_000, owedCents: 20_000 },
      ],
    };
    expect(diffSnapshots(base, next, nameOf).parts).toEqual([
      `paid by You → You ${inr(30_000)} & Asha ${inr(10_000)}`,
    ]);
  });

  it('covers description, category and notes', () => {
    const next = { ...base, description: 'Lunch', category: 'travel' as const, notes: 'cab' };
    expect(diffSnapshots(base, next, nameOf).parts).toEqual([
      'description “Dinner” → “Lunch”',
      'category Food & drink → Travel',
      'added notes',
    ]);
    expect(diffSnapshots(next, { ...next, notes: 'taxi' }, nameOf).parts).toEqual(['notes']);
    expect(diffSnapshots(next, { ...next, notes: null }, nameOf).parts).toEqual(['removed notes']);
  });
});

describe('describeRevisions', () => {
  const edited: ExpenseSnapshot = {
    ...base,
    amountCents: 45_000,
    shares: [
      { userId: 1, paidCents: 45_000, owedCents: 22_500 },
      { userId: 2, paidCents: 0, owedCents: 22_500 },
    ],
  };
  const history = [
    rev(4, 'restored', 1, base),
    rev(3, 'deleted', 3, edited),
    rev(2, 'updated', 2, edited),
    rev(1, 'created', 1, base),
  ];

  it('titles each revision against the one before it', () => {
    const lines = describeRevisions(history, nameOf, base);
    expect(lines.map((l) => l.title)).toEqual([
      `You restored an earlier version: amount ${inr(45_000)} → ${inr(40_000)}, split`,
      'Bilal deleted this',
      `Asha changed amount ${inr(40_000)} → ${inr(45_000)}, split`,
      `You added this for ${inr(40_000)}`,
    ]);
    expect(lines[2].splitLines).toHaveLength(2);
    expect(lines[1].splitLines).toEqual([]);
  });

  it('offers restore only for versions that differ from the current state', () => {
    const lines = describeRevisions(history, nameOf, base);
    expect(lines.map((l) => l.restorable)).toEqual([false, true, true, false]);
  });

  it('offers every version of a deleted expense', () => {
    const lines = describeRevisions(history.slice(1), nameOf, null);
    expect(lines.every((l) => l.restorable)).toBe(true);
  });

  it('notes a save without changes and a plain undelete', () => {
    const lines = describeRevisions(
      [rev(3, 'restored', 2, base), rev(2, 'updated', 3, base), rev(1, 'created', 1, base)],
      nameOf,
      base,
    );
    expect(lines[0].title).toBe('Asha restored this');
    expect(lines[1].title).toBe('Bilal saved without changes');
  });
});

describe('helpers', () => {
  it('joins names', () => {
    expect(joinNames([])).toBe('nobody');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B & C');
  });

  it('treats blank notes and share order as the same snapshot', () => {
    expect(sameSnapshot(base, { ...base, notes: '' })).toBe(true);
    expect(sameSnapshot(base, { ...base, amountCents: 1 })).toBe(false);
  });
});
