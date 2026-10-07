import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  addMonths,
  dueBetween,
  firstAfter,
  firstOnOrAfter,
  intentUserIds,
  occurrenceDate,
  resolveShares,
  type Schedule,
} from './recurrence';

const monthly = (anchorDate: string, interval = 1): Schedule => ({
  cadence: 'monthly',
  interval,
  anchorDate,
});
const dates = (s: Schedule, count: number) =>
  Array.from({ length: count }, (_, n) => occurrenceDate(s, n));

describe('calendar arithmetic', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  it('adds months, clamping to the end of shorter months', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
    assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  });

  it('is timezone-agnostic: DST-change days are ordinary days', () => {
    // US and EU DST transitions; local-time arithmetic would skip or repeat.
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-03-29', 1), '2026-03-30');
    assert.equal(addDays('2026-10-25', 7), '2026-11-01');
    const tz = process.env.TZ;
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
        process.env.TZ = zone;
        assert.equal(addDays('2026-03-08', 1), '2026-03-09');
        assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('occurrenceDate', () => {
  it('monthly on the 31st clamps per month without drifting', () => {
    assert.deepEqual(dates(monthly('2026-01-31'), 5), [
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('monthly on the 30th/29th in February of leap and common years', () => {
    assert.deepEqual(dates(monthly('2027-12-30'), 3), ['2027-12-30', '2028-01-30', '2028-02-29']);
    assert.deepEqual(dates(monthly('2026-01-29'), 3), ['2026-01-29', '2026-02-28', '2026-03-29']);
  });

  it('weekly, with intervals', () => {
    const weekly: Schedule = { cadence: 'weekly', interval: 1, anchorDate: '2026-12-28' };
    assert.deepEqual(dates(weekly, 3), ['2026-12-28', '2027-01-04', '2027-01-11']);
    const fortnightly: Schedule = { ...weekly, interval: 2 };
    assert.deepEqual(dates(fortnightly, 3), ['2026-12-28', '2027-01-11', '2027-01-25']);
  });

  it('every N months', () => {
    assert.deepEqual(dates(monthly('2026-11-30', 3), 3), [
      '2026-11-30',
      '2027-02-28',
      '2027-05-30',
    ]);
  });

  it('yearly on Feb 29 lands on Feb 28 in common years and back on the 29th', () => {
    const leap: Schedule = { cadence: 'yearly', interval: 1, anchorDate: '2028-02-29' };
    assert.deepEqual(dates(leap, 5), [
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
    const biennial: Schedule = { cadence: 'yearly', interval: 2, anchorDate: '2026-06-15' };
    assert.deepEqual(dates(biennial, 3), ['2026-06-15', '2028-06-15', '2030-06-15']);
  });
});

describe('first occurrence on/after a date', () => {
  it('finds the next period, or the anchor when it is still ahead', () => {
    const s = monthly('2026-01-31');
    assert.equal(firstOnOrAfter(s, '2026-02-28'), '2026-02-28');
    assert.equal(firstOnOrAfter(s, '2026-03-01'), '2026-03-31');
    assert.equal(firstAfter(s, '2026-02-28'), '2026-03-31');
    assert.equal(firstOnOrAfter(s, '2025-06-01'), '2026-01-31');
  });
});

describe('dueBetween', () => {
  it('returns every missed occurrence up to and including today', () => {
    const r = dueBetween(monthly('2026-07-01'), '2026-07-01', '2026-10-01');
    assert.deepEqual(r.dates, ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    assert.equal(r.nextDue, '2026-11-01');
  });

  it('starts at next_due, so already-generated dates are not returned', () => {
    const r = dueBetween(monthly('2026-07-01'), '2026-09-01', '2026-10-07');
    assert.deepEqual(r.dates, ['2026-09-01', '2026-10-01']);
    assert.equal(r.nextDue, '2026-11-01');
  });

  it('returns nothing before the first due date', () => {
    const r = dueBetween(monthly('2026-11-01'), '2026-11-01', '2026-10-07');
    assert.deepEqual(r.dates, []);
    assert.equal(r.nextDue, '2026-11-01');
  });

  it('caps a long catch-up to the most recent occurrences', () => {
    const weekly: Schedule = { cadence: 'weekly', interval: 1, anchorDate: '2025-01-06' };
    const r = dueBetween(weekly, '2025-01-06', '2026-10-07', 24);
    assert.equal(r.dates.length, 24);
    assert.equal(r.dates.at(-1), '2026-10-05');
    assert.equal(r.nextDue, '2026-10-12');
    assert.equal(dueBetween(weekly, '2025-01-06', '2026-10-07', 3).dates.length, 3);
  });

  it('is stable when re-run from its own nextDue (no duplicates across runs)', () => {
    const s = monthly('2026-01-31');
    const first = dueBetween(s, '2026-01-31', '2026-03-15');
    const second = dueBetween(s, first.nextDue, '2026-05-31');
    assert.deepEqual(first.dates, ['2026-01-31', '2026-02-28']);
    assert.deepEqual(second.dates, ['2026-03-31', '2026-04-30', '2026-05-31']);
  });
});

describe('resolveShares', () => {
  const payers = (userId: number, cents: number) => [{ userId, cents }];

  it('equal splits re-split for a new amount (remainder to the lowest ids)', () => {
    const split = { mode: 'equal' as const, participants: [3, 1, 2], payers: payers(1, 3000) };
    assert.deepEqual(resolveShares(split, 3000), [
      { userId: 1, paidCents: 3000, owedCents: 1000 },
      { userId: 2, paidCents: 0, owedCents: 1000 },
      { userId: 3, paidCents: 0, owedCents: 1000 },
    ]);
    assert.deepEqual(
      resolveShares(split, 1000).map((s) => s.owedCents),
      [334, 333, 333],
    );
    assert.equal(resolveShares(split, 1000)[0].paidCents, 1000, 'single payer pays the new amount');
  });

  it('exact amounts are kept as-is, or scaled for a different amount', () => {
    const split = {
      mode: 'exact' as const,
      participants: [1, 2],
      values: [
        { userId: 1, value: 2000 },
        { userId: 2, value: 1000 },
      ],
      payers: payers(2, 3000),
    };
    assert.deepEqual(resolveShares(split, 3000), [
      { userId: 1, paidCents: 0, owedCents: 2000 },
      { userId: 2, paidCents: 3000, owedCents: 1000 },
    ]);
    assert.deepEqual(
      resolveShares(split, 6000).map((s) => s.owedCents),
      [4000, 2000],
    );
  });

  it('percent and shares keep their ratios', () => {
    const percent = {
      mode: 'percent' as const,
      participants: [1, 2],
      values: [
        { userId: 1, value: 7000 },
        { userId: 2, value: 3000 },
      ],
      payers: payers(1, 1000),
    };
    assert.deepEqual(
      resolveShares(percent, 2000).map((s) => s.owedCents),
      [1400, 600],
    );
    const shares = {
      mode: 'shares' as const,
      participants: [1, 2, 3],
      values: [
        { userId: 1, value: 2 },
        { userId: 2, value: 1 },
        { userId: 3, value: 0 },
      ],
      payers: payers(1, 900),
    };
    const out = resolveShares(shares, 900);
    assert.deepEqual(
      out.map((s) => [s.userId, s.owedCents]),
      [
        [1, 600],
        [2, 300],
      ],
    );
  });

  it('multiple payers scale proportionally and every total adds up', () => {
    const split = {
      mode: 'equal' as const,
      participants: [1, 2],
      payers: [
        { userId: 1, cents: 1000 },
        { userId: 2, cents: 2000 },
      ],
    };
    const out = resolveShares(split, 3001);
    assert.equal(
      out.reduce((s, x) => s + x.paidCents, 0),
      3001,
    );
    assert.equal(
      out.reduce((s, x) => s + x.owedCents, 0),
      3001,
    );
  });

  it('keeps required people at zero (1:1 bills carry both)', () => {
    const split = { mode: 'equal' as const, participants: [2], payers: payers(1, 500) };
    assert.deepEqual(resolveShares(split, 500, [1, 2]), [
      { userId: 1, paidCents: 500, owedCents: 0 },
      { userId: 2, paidCents: 0, owedCents: 500 },
    ]);
    const self = { mode: 'equal' as const, participants: [1], payers: payers(1, 500) };
    assert.deepEqual(resolveShares(self, 500, [1, 2])[1], {
      userId: 2,
      paidCents: 0,
      owedCents: 0,
    });
  });

  it('lists everyone the intent involves', () => {
    assert.deepEqual(
      intentUserIds({
        mode: 'shares',
        participants: [1, 2, 3],
        values: [
          { userId: 2, value: 1 },
          { userId: 3, value: 0 },
        ],
        payers: payers(4, 100),
      }),
      [2, 4],
    );
  });
});
