import { describe, expect, it } from 'vitest';
import {
  MAX_CENTS,
  currencyDigits,
  formatAmountInput,
  formatMoney,
  isCanonicalAmount,
  localeDecimalSeparator,
  normalizeAmountText,
  parseAmountToCents,
  splitByWeights,
  splitEqual,
} from './money';

/** Tiny deterministic LCG for property-style loops (no unseeded randomness). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const digitsOf = (formatted: string): string => formatted.replace(/\D/g, '');

describe('splitEqual', () => {
  it('splits evenly with no remainder', () => {
    expect(splitEqual(3000, [1, 2, 3])).toEqual([
      { userId: 1, owedCents: 1000 },
      { userId: 2, owedCents: 1000 },
      { userId: 3, owedCents: 1000 },
    ]);
  });

  it('gives the remainder one cent at a time to the earliest users', () => {
    expect(splitEqual(100, [7, 8, 9])).toEqual([
      { userId: 7, owedCents: 34 },
      { userId: 8, owedCents: 33 },
      { userId: 9, owedCents: 33 },
    ]);
    expect(splitEqual(1, [4, 5, 6])).toEqual([
      { userId: 4, owedCents: 1 },
      { userId: 5, owedCents: 0 },
      { userId: 6, owedCents: 0 },
    ]);
  });

  it('returns [] for an empty user list', () => {
    expect(splitEqual(1000, [])).toEqual([]);
  });

  it('always sums exactly to the amount (LCG loop)', () => {
    const rand = lcg(42);
    for (let iter = 0; iter < 200; iter++) {
      const n = 1 + Math.floor(rand() * 8);
      const amount = 1 + Math.floor(rand() * 100_000);
      const userIds = Array.from({ length: n }, (_, i) => i + 1);
      const shares = splitEqual(amount, userIds);
      const sum = shares.reduce((acc, s) => acc + s.owedCents, 0);
      expect(sum).toBe(amount);
      const max = Math.max(...shares.map((s) => s.owedCents));
      const min = Math.min(...shares.map((s) => s.owedCents));
      expect(max - min).toBeLessThanOrEqual(1);
    }
  });
});

describe('splitByWeights', () => {
  it('splits proportionally with exact sums', () => {
    expect(splitByWeights(1000, [
      { userId: 1, weight: 700 },
      { userId: 2, weight: 300 },
    ])).toEqual([
      { userId: 1, owedCents: 700 },
      { userId: 2, owedCents: 300 },
    ]);
  });

  it('rounds by largest remainder, index tie-break', () => {
    // 100 / weights 1:1:1 -> 33.33 each, remainder 1 goes to the first index
    expect(splitByWeights(100, [
      { userId: 1, weight: 1 },
      { userId: 2, weight: 1 },
      { userId: 3, weight: 1 },
    ])).toEqual([
      { userId: 1, owedCents: 34 },
      { userId: 2, owedCents: 33 },
      { userId: 3, owedCents: 33 },
    ]);
  });

  it('gives zero-weight members exactly zero', () => {
    const shares = splitByWeights(101, [
      { userId: 1, weight: 2 },
      { userId: 2, weight: 0 },
      { userId: 3, weight: 1 },
    ]);
    expect(shares.find((s) => s.userId === 2)?.owedCents).toBe(0);
    expect(shares.reduce((acc, s) => acc + s.owedCents, 0)).toBe(101);
  });

  it('handles a 1-cent amount', () => {
    expect(splitByWeights(1, [
      { userId: 1, weight: 0 },
      { userId: 2, weight: 1 },
      { userId: 3, weight: 1 },
    ])).toEqual([
      { userId: 1, owedCents: 0 },
      { userId: 2, owedCents: 1 },
      { userId: 3, owedCents: 0 },
    ]);
  });

  it('returns [] for empty entries or all-zero weights', () => {
    expect(splitByWeights(100, [])).toEqual([]);
    expect(splitByWeights(100, [{ userId: 1, weight: 0 }])).toEqual([]);
  });

  it('is exact for random weights incl. zeros (LCG loop)', () => {
    const rand = lcg(7);
    for (let iter = 0; iter < 200; iter++) {
      const n = 1 + Math.floor(rand() * 6);
      const amount = 1 + Math.floor(rand() * 1_000_000);
      const entries = Array.from({ length: n }, (_, i) => ({
        userId: i + 1,
        weight: Math.floor(rand() * 10),
      }));
      if (entries.every((e) => e.weight === 0)) entries[0].weight = 1;
      const shares = splitByWeights(amount, entries);
      expect(shares.reduce((acc, s) => acc + s.owedCents, 0)).toBe(amount);
      for (let i = 0; i < n; i++) {
        expect(shares[i].owedCents).toBeGreaterThanOrEqual(0);
        if (entries[i].weight === 0) expect(shares[i].owedCents).toBe(0);
      }
    }
  });
});

describe('parseAmountToCents', () => {
  it('parses valid decimal amounts (USD)', () => {
    expect(parseAmountToCents('12.50', 'USD')).toBe(1250);
    expect(parseAmountToCents('12', 'USD')).toBe(1200);
    expect(parseAmountToCents('0.01', 'USD')).toBe(1);
    expect(parseAmountToCents('1,250.50', 'USD', 'en-US')).toBe(125050);
    expect(parseAmountToCents(' 12.5 ', 'USD')).toBe(1250);
    expect(parseAmountToCents('.5', 'USD')).toBe(50);
    // Half-cent inputs round half-up via exact string math, immune to floats
    // (1.005 as a double is 1.00499…95).
    expect(parseAmountToCents('1.005', 'USD', 'en-US')).toBe(101);
  });

  it('rejects garbage', () => {
    expect(parseAmountToCents('', 'USD')).toBeNull();
    expect(parseAmountToCents('abc', 'USD')).toBeNull();
    expect(parseAmountToCents('12.3.4', 'USD')).toBeNull();
    expect(parseAmountToCents('12abc', 'USD')).toBeNull();
    expect(parseAmountToCents('$12', 'USD')).toBeNull();
  });

  it('rejects negative and zero amounts', () => {
    expect(parseAmountToCents('-5', 'USD')).toBeNull();
    expect(parseAmountToCents('0', 'USD')).toBeNull();
    expect(parseAmountToCents('0.00', 'USD')).toBeNull();
  });

  it('rejects amounts over the cap and accepts the cap', () => {
    expect(parseAmountToCents('1000000', 'USD')).toBe(MAX_CENTS);
    expect(parseAmountToCents('1000000.01', 'USD')).toBeNull();
    expect(parseAmountToCents('99999999', 'USD')).toBeNull();
  });

  it('uses 0 minor digits for JPY', () => {
    expect(parseAmountToCents('500', 'JPY')).toBe(500);
    expect(parseAmountToCents('100000000', 'JPY')).toBe(MAX_CENTS);
    expect(parseAmountToCents('100000001', 'JPY')).toBeNull();
  });
});

describe('formatMoney / currencyDigits', () => {
  it('reports minor-unit digits per currency', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
  });

  it('formats USD cents as major units', () => {
    const formatted = formatMoney(123456, 'USD');
    expect(digitsOf(formatted)).toBe('123456');
    const ref = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
    expect(formatted).toBe(ref.format(1234.56));
  });

  it('formats JPY without dividing by 100', () => {
    const formatted = formatMoney(1250, 'JPY');
    expect(digitsOf(formatted)).toBe('1250');
    const ref = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'JPY' });
    expect(formatted).toBe(ref.format(1250));
  });
});

describe('parseAmountToCents expressions', () => {
  it('splits with division', () => {
    expect(parseAmountToCents('1240/3', 'USD')).toBe(41333);
    expect(parseAmountToCents('1200/3', 'JPY')).toBe(400);
  });
  it('adds and multiplies', () => {
    expect(parseAmountToCents('740+120', 'USD')).toBe(86000);
    expect(parseAmountToCents('10*3', 'USD')).toBe(3000);
    expect(parseAmountToCents('(100-40)/2', 'USD')).toBe(3000);
    expect(parseAmountToCents('12.5+0.25', 'USD')).toBe(1275);
  });
  it('rejects invalid expressions', () => {
    expect(parseAmountToCents('10/0', 'USD')).toBeNull();
    expect(parseAmountToCents('5-10', 'USD')).toBeNull();
    expect(parseAmountToCents('10+', 'USD')).toBeNull();
    expect(parseAmountToCents('(10', 'USD')).toBeNull();
    expect(parseAmountToCents('1e3+1', 'USD')).toBeNull();
  });
});

describe('float-boundary safety (0.1 + 0.2 class)', () => {
  it('classic float traps round correctly at the cent boundary', () => {
    // raw JS: 0.3 - 0.1 === 0.19999999999999998
    expect(parseAmountToCents('0.3-0.1', 'USD')).toBe(20);
    // raw JS: 0.1 + 0.2 === 0.30000000000000004
    expect(parseAmountToCents('0.1+0.2', 'USD')).toBe(30);
    // raw JS: 0.29 * 100 === 28.999999999999996
    expect(parseAmountToCents('0.29', 'USD')).toBe(29);
    expect(parseAmountToCents('1.005', 'USD', 'en-US')).toBe(101);
  });
  it('split sums are exact regardless of float intermediates', () => {
    for (const amount of [100, 1000, 99999, 100000001 - 1]) {
      const shares = splitByWeights(amount, [
        { userId: 1, weight: 3333 },
        { userId: 2, weight: 3333 },
        { userId: 3, weight: 3334 },
      ]);
      expect(shares.reduce((s, x) => s + x.owedCents, 0)).toBe(amount);
    }
  });
});

describe('locale-aware separators', () => {
  it('detects the locale decimal separator', () => {
    expect(localeDecimalSeparator('en-US')).toBe('.');
    expect(localeDecimalSeparator('de-DE')).toBe(',');
  });

  it('treats a comma followed by 1–2 digits as decimal in every locale', () => {
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'en-IN']) {
      expect(parseAmountToCents('12,50', 'EUR', locale)).toBe(1250);
      expect(parseAmountToCents('12,5', 'EUR', locale)).toBe(1250);
      expect(parseAmountToCents(',5', 'EUR', locale)).toBe(50);
    }
  });

  it('never multiplies "12,50" by 100 (regression)', () => {
    expect(parseAmountToCents('12,50', 'EUR', 'en-US')).not.toBe(125000);
  });

  it('treats ",ddd" groups as grouping only in a "."-decimal locale', () => {
    expect(parseAmountToCents('1,234', 'USD', 'en-US')).toBe(123400);
    expect(normalizeAmountText('1,234,567', 'en-US')).toBe('1234567');
    expect(parseAmountToCents('12,345', 'USD', 'en-US')).toBe(1234500);
    // In a ','-decimal locale the same text is a decimal.
    expect(parseAmountToCents('1,234', 'EUR', 'de-DE')).toBe(123);
    expect(parseAmountToCents('1,235', 'EUR', 'de-DE')).toBe(124);
  });

  it('handles both separators: the last one is the decimal mark', () => {
    expect(parseAmountToCents('1,234.56', 'USD', 'en-US')).toBe(123456);
    expect(parseAmountToCents('1.234,56', 'EUR', 'en-US')).toBe(123456);
    expect(parseAmountToCents('1.234,56', 'EUR', 'de-DE')).toBe(123456);
    expect(parseAmountToCents('1.234.567,8', 'EUR', 'de-DE')).toBeNull(); // over cap
    expect(normalizeAmountText('1.234.567,8', 'de-DE')).toBe('1234567.8');
  });

  it('treats ".ddd" as grouping in a ","-decimal locale', () => {
    expect(parseAmountToCents('1.234', 'EUR', 'de-DE')).toBe(123400);
    expect(parseAmountToCents('1.234.567', 'EUR', 'de-DE')).toBeNull(); // over cap
    expect(normalizeAmountText('1.234.567', 'de-DE')).toBe('1234567');
    expect(parseAmountToCents('12.50', 'EUR', 'de-DE')).toBe(1250);
  });

  it('rejects ambiguous or malformed grouping instead of guessing', () => {
    expect(parseAmountToCents('1234,567', 'USD', 'en-US')).toBeNull();
    expect(parseAmountToCents('1,2345', 'USD', 'en-US')).toBeNull();
    expect(parseAmountToCents('1,23,4', 'USD', 'en-US')).toBeNull();
    expect(parseAmountToCents('1,23.45', 'USD', 'en-US')).toBeNull();
    expect(parseAmountToCents('12,50,1', 'EUR', 'de-DE')).toBeNull();
    expect(parseAmountToCents('1.2345', 'EUR', 'de-DE')).toBeNull();
    expect(parseAmountToCents('1,2.3', 'USD', 'en-US')).toBeNull();
  });

  it('normalizes each number inside an expression', () => {
    expect(parseAmountToCents('12,50+2,50', 'EUR', 'en-US')).toBe(1500);
    expect(parseAmountToCents('1.000,50/2', 'EUR', 'de-DE')).toBe(50025);
    expect(parseAmountToCents('1,5 * 2', 'EUR', 'de-DE')).toBe(300);
  });

  it('strips spaces including no-break spaces used as grouping', () => {
    expect(parseAmountToCents('1 234,50', 'EUR', 'fr-FR')).toBe(123450);
    expect(parseAmountToCents('1\u202f234,50', 'EUR', 'fr-FR')).toBe(123450);
  });

  it('flags non-canonical input for the parsed preview', () => {
    expect(isCanonicalAmount('12.50')).toBe(true);
    expect(isCanonicalAmount('12')).toBe(true);
    expect(isCanonicalAmount('.5')).toBe(true);
    expect(isCanonicalAmount('12,50')).toBe(false);
    expect(isCanonicalAmount('1,234')).toBe(false);
    expect(isCanonicalAmount('10/2')).toBe(false);
  });
});

describe('Indian digit grouping', () => {
  it('parses lakh/crore grouping as typed or pasted', () => {
    expect(parseAmountToCents('2,81,152.66', 'INR', 'en-IN')).toBe(28115266);
    expect(parseAmountToCents('2,81,152.66', 'INR', 'en-US')).toBe(28115266);
    expect(parseAmountToCents('1,00,000', 'INR', 'en-IN')).toBe(10000000);
    expect(normalizeAmountText('1,00,00,000', 'en-IN')).toBe('10000000');
    expect(parseAmountToCents('47,915.46', 'INR', 'en-IN')).toBe(4791546);
  });

  it('still rejects malformed grouping', () => {
    expect(parseAmountToCents('2,81,15.66', 'INR', 'en-IN')).toBeNull();
    expect(parseAmountToCents('281,52,152', 'INR', 'en-IN')).toBeNull();
    expect(parseAmountToCents('2,8,152', 'INR', 'en-IN')).toBeNull();
    // A ','-decimal locale never reads commas as grouping.
    expect(parseAmountToCents('2,81,152', 'EUR', 'de-DE')).toBeNull();
  });

  it('formats an amount for editing and reads it back exactly', () => {
    expect(formatAmountInput(28115266, 'INR', 'en-IN')).toBe('2,81,152.66');
    expect(formatAmountInput(28115266, 'USD', 'en-US')).toBe('281,152.66');
    expect(formatAmountInput(28115266, 'EUR', 'de-DE')).toBe('281.152,66');
    expect(formatAmountInput(500, 'JPY', 'en-US')).toBe('500');
    for (const [cents, locale] of [
      [12345678, 'en-IN'],
      [99, 'fr-FR'],
      [100000000, 'de-DE'],
    ] as const) {
      const text = formatAmountInput(cents, 'EUR', locale);
      expect(parseAmountToCents(text, 'EUR', locale)).toBe(cents);
    }
  });
});
