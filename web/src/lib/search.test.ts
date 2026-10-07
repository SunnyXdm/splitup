import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FILTERS,
  amountMatches,
  buildPredicate,
  compileQuery,
  expenseHaystack,
  filterExpenses,
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  matchesQuery,
  normalizeText,
  parseAmountQuery,
  resolveDateRange,
  type HistoryFilters,
} from './search';
import type { Expense, ExpenseShare, SyncData } from './types';

let idSeq = 1;

function exp(o: Partial<Expense> & { shares?: ExpenseShare[] }): Expense {
  const shares = o.shares ?? [
    {
      userId: 1,
      paidCents: o.amountCents ?? 1000,
      owedCents: (o.amountCents ?? 1000) / 2,
    },
    { userId: 2, paidCents: 0, owedCents: (o.amountCents ?? 1000) / 2 },
  ];
  return {
    id: idSeq++,
    groupId: null,
    description: 'Thing',
    amountCents: 1000,
    currency: 'USD',
    date: '2026-10-05',
    category: 'general',
    notes: null,
    isPayment: false,
    createdBy: 1,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    ...o,
    shares,
  };
}

function sync(expenses: Expense[]): SyncData {
  return {
    me: {
      id: 1,
      name: 'Sunny',
      email: null,
      picture: null,
      defaultCurrency: 'INR',
    },
    users: [
      { id: 1, name: 'Sunny', email: null, picture: null },
      { id: 2, name: 'Zoë Müller', email: null, picture: null },
      { id: 3, name: 'Arjun', email: null, picture: null },
    ],
    friendIds: [2, 3],
    groups: [],
    expenses,
    activity: [],
    syncedAt: '2026-10-05T00:00:00Z',
  };
}

const f = (o: Partial<HistoryFilters>): HistoryFilters => ({
  ...DEFAULT_FILTERS,
  ...o,
});

describe('normalizeText', () => {
  it('folds case and diacritics', () => {
    expect(normalizeText('  Café  CRÈME ')).toBe('cafe creme');
    expect(normalizeText('Zoë Müller')).toBe('zoe muller');
    expect(normalizeText('Ångström')).toBe('angstrom');
  });
});

describe('query matching', () => {
  it('matches description and notes, diacritic- and case-insensitively', () => {
    const e = exp({
      description: 'Crêpes at Café Flore',
      notes: 'Birthday brunch',
    });
    const s = sync([e]);
    expect(matchesQuery(s, e, compileQuery('cafe'))).toBe(true);
    expect(matchesQuery(s, e, compileQuery('CRÉPES'))).toBe(true);
    expect(matchesQuery(s, e, compileQuery('brunch'))).toBe(true);
    expect(matchesQuery(s, e, compileQuery('dinner'))).toBe(false);
  });

  it('requires every token (AND)', () => {
    const e = exp({ description: 'Goa taxi' });
    const s = sync([e]);
    expect(matchesQuery(s, e, compileQuery('goa taxi'))).toBe(true);
    expect(matchesQuery(s, e, compileQuery('goa hotel'))).toBe(false);
  });

  it('matches payer names, including "you" for me', () => {
    const byZoe = exp({
      shares: [
        { userId: 2, paidCents: 1000, owedCents: 500 },
        { userId: 1, paidCents: 0, owedCents: 500 },
      ],
    });
    const byMe = exp({});
    const s = sync([byZoe, byMe]);
    expect(matchesQuery(s, byZoe, compileQuery('zoe'))).toBe(true);
    expect(matchesQuery(s, byZoe, compileQuery('muller'))).toBe(true);
    // A non-paying participant's name doesn't match.
    expect(matchesQuery(s, byMe, compileQuery('zoe'))).toBe(false);
    expect(matchesQuery(s, byMe, compileQuery('you'))).toBe(true);
    expect(matchesQuery(s, byMe, compileQuery('sunny'))).toBe(true);
  });

  it('memoizes haystacks per snapshot', () => {
    const e = exp({ description: 'Tea' });
    const s1 = sync([e]);
    expect(expenseHaystack(s1, e)).toBe(expenseHaystack(s1, e));
    const s2 = {
      ...s1,
      users: s1.users.map((u) => (u.id === 1 ? { ...u, name: 'Renamed' } : u)),
    };
    s2.me = { ...s2.me, name: 'Renamed' };
    expect(expenseHaystack(s2, e)).toContain('renamed');
  });
});

describe('amount matching', () => {
  it('parses numeric tokens, stripping symbols and grouping', () => {
    expect(parseAmountQuery('450', 'en-US')).toEqual({
      whole: '450',
      frac: null,
    });
    expect(parseAmountQuery('₹450', 'en-US')).toEqual({
      whole: '450',
      frac: null,
    });
    expect(parseAmountQuery('1,234.50', 'en-US')).toEqual({
      whole: '1234',
      frac: '50',
    });
    expect(parseAmountQuery('12,5', 'de-DE')).toEqual({
      whole: '12',
      frac: '5',
    });
    expect(parseAmountQuery('taxi', 'en-US')).toBeNull();
    expect(parseAmountQuery('4+5', 'en-US')).toBeNull();
  });

  it('"450" matches ₹450.00 (2 digits) and ¥450 (0 digits)', () => {
    const q = parseAmountQuery('450', 'en-US')!;
    expect(amountMatches(45000, 'INR', q)).toBe(true);
    expect(amountMatches(45075, 'INR', q)).toBe(true);
    expect(amountMatches(450, 'JPY', q)).toBe(true);
    expect(amountMatches(4500, 'INR', q)).toBe(false);
    expect(amountMatches(4500, 'JPY', q)).toBe(false);
  });

  it('decimals compare against the currency minor digits', () => {
    const half = parseAmountQuery('450.5', 'en-US')!;
    expect(amountMatches(45050, 'USD', half)).toBe(true);
    expect(amountMatches(45005, 'USD', half)).toBe(false);
    expect(amountMatches(450, 'JPY', half)).toBe(false);
    const zeros = parseAmountQuery('450.00', 'en-US')!;
    expect(amountMatches(450, 'JPY', zeros)).toBe(true);
    expect(amountMatches(45000, 'USD', zeros)).toBe(true);
    // 3-digit currency (Bahraini dinar): 12.345
    expect(amountMatches(12345, 'BHD', parseAmountQuery('12.345', 'en-US')!)).toBe(true);
    expect(amountMatches(12345, 'BHD', parseAmountQuery('12.34', 'en-US')!)).toBe(false);
    expect(amountMatches(12340, 'BHD', parseAmountQuery('12.34', 'en-US')!)).toBe(true);
  });

  it('a numeric token can match either text or amount', () => {
    const e = exp({ description: 'Room 450', amountCents: 999 });
    const f2 = exp({
      description: 'Dinner',
      amountCents: 45000,
      currency: 'INR',
    });
    const s = sync([e, f2]);
    const q = compileQuery('450', 'en-US');
    expect(matchesQuery(s, e, q)).toBe(true);
    expect(matchesQuery(s, f2, q)).toBe(true);
  });
});

describe('date ranges (local time)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('this month / last month across a year boundary', () => {
    const now = new Date(2026, 0, 15, 12);
    expect(resolveDateRange('this-month', now)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(resolveDateRange('last-month', now)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('last month from the 31st lands on a short February', () => {
    const now = new Date(2026, 2, 31, 23, 59);
    expect(resolveDateRange('last-month', now)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(resolveDateRange('last-month', new Date(2028, 2, 31))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('last 30 days is inclusive of today', () => {
    expect(resolveDateRange('30d', new Date(2026, 9, 7, 0, 5))).toEqual({
      from: '2026-09-08',
      to: '2026-10-07',
    });
  });

  it('uses the local calendar day, not UTC', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');
    // 20:00 UTC on Sep 30 is 01:30 on Oct 1 in India.
    const now = new Date('2026-09-30T20:00:00Z');
    expect(resolveDateRange('this-month', now)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    vi.stubEnv('TZ', 'America/Los_Angeles');
    // 03:00 UTC on Oct 1 is still Sep 30 in California.
    const la = new Date('2026-10-01T03:00:00Z');
    expect(resolveDateRange('this-month', la)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('custom ranges: open ends, swapped ends, garbage ignored', () => {
    const now = new Date(2026, 9, 7);
    expect(resolveDateRange('custom', now, '2026-10-01', null)).toEqual({
      from: '2026-10-01',
      to: null,
    });
    expect(resolveDateRange('custom', now, '2026-10-09', '2026-10-01')).toEqual({
      from: '2026-10-01',
      to: '2026-10-09',
    });
    expect(resolveDateRange('custom', now, 'nope', '2026-02-30')).toEqual({
      from: null,
      to: null,
    });
  });

  it('month boundary days are included', () => {
    const now = new Date(2026, 9, 7);
    const s = sync([
      exp({ date: '2026-09-30' }),
      exp({ date: '2026-10-01' }),
      exp({ date: '2026-10-31' }),
      exp({ date: '2026-11-01' }),
    ]);
    const got = filterExpenses(s, s.expenses, f({ range: 'this-month' }), now).map((e) => e.date);
    expect(got).toEqual(['2026-10-01', '2026-10-31']);
  });
});

describe('filters', () => {
  const payment = exp({
    isPayment: true,
    description: 'Payment',
    amountCents: 500,
    shares: [
      { userId: 2, paidCents: 500, owedCents: 0 },
      { userId: 1, paidCents: 0, owedCents: 500 },
    ],
  });
  const food = exp({ category: 'food', groupId: 7 });
  const travelByArjun = exp({
    category: 'travel',
    shares: [
      { userId: 3, paidCents: 1000, owedCents: 500 },
      { userId: 1, paidCents: 0, owedCents: 500 },
    ],
  });
  const s = sync([payment, food, travelByArjun]);
  const run = (o: Partial<HistoryFilters>) =>
    s.expenses.filter(buildPredicate(s, f(o), new Date(2026, 9, 7))).map((e) => e.id);

  it('type', () => {
    expect(run({ type: 'payments' })).toEqual([payment.id]);
    expect(run({ type: 'expenses' })).toEqual([food.id, travelByArjun.id]);
  });

  it('payer: me / specific person', () => {
    expect(run({ payer: 'me' })).toEqual([food.id]);
    expect(run({ payer: 3 })).toEqual([travelByArjun.id]);
    expect(run({ payer: 2 })).toEqual([payment.id]);
  });

  it('category excludes payments', () => {
    expect(run({ category: 'food' })).toEqual([food.id]);
    expect(run({ category: 'general' })).toEqual([]);
  });

  it('group: direct / specific', () => {
    expect(run({ group: 'direct' })).toEqual([payment.id, travelByArjun.id]);
    expect(run({ group: 7 })).toEqual([food.id]);
  });

  it('no active filters returns the same array (no copy)', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(filterExpenses(s, s.expenses, DEFAULT_FILTERS)).toBe(s.expenses);
  });

  it('scales linearly on a long list', () => {
    const many = Array.from({ length: 20000 }, (_, i) =>
      exp({ description: `Item ${i}`, amountCents: 100 + i }),
    );
    const big = sync(many);
    const t0 = performance.now();
    const out = filterExpenses(big, many, f({ q: 'item 1999' }));
    expect(out.length).toBe(12); // 1999, 11999, 19990–19999
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('URL params', () => {
  it('round-trips and omits defaults', () => {
    const filters = f({
      q: 'café 450',
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-07',
      payer: 'me',
      category: 'food',
      type: 'expenses',
      group: 'direct',
    });
    const params = filtersToParams(filters, new URLSearchParams('tab=expenses'));
    expect(params.get('tab')).toBe('expenses');
    expect(filtersFromParams(params)).toEqual(filters);
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe('');
  });

  it('drops custom bounds for presets and tolerates junk', () => {
    expect(filtersToParams(f({ range: 'this-month', from: '2026-01-01' })).toString()).toBe(
      'range=this-month',
    );
    const parsed = filtersFromParams(
      new URLSearchParams('range=bogus&payer=-3&cat=nope&type=x&group=0&from=2026-13-01'),
    );
    expect(parsed).toEqual(DEFAULT_FILTERS);
    expect(filtersFromParams(new URLSearchParams('payer=12&group=4'))).toMatchObject({
      payer: 12,
      group: 4,
    });
  });
});
