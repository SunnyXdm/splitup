export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'SGD', 'AED', 'CHF'] as const;

export const MAX_CENTS = 100_000_000;

const fmtCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string): Intl.NumberFormat {
  let fmt = fmtCache.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    fmtCache.set(currency, fmt);
  }
  return fmt;
}

/** Number of minor-unit digits for a currency (2 for USD, 0 for JPY, …). */
export function currencyDigits(currency: string): number {
  return formatter(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Format an integer minor-unit amount ("cents") as a localized currency string. */
export function formatMoney(cents: number, currency: string): string {
  return formatter(currency).format(cents / 10 ** currencyDigits(currency));
}

/**
 * Tiny arithmetic evaluator (+ - * / and parentheses) — no eval. Returns null
 * on any malformed input, division by zero, or trailing garbage.
 */
function evaluateExpression(s: string): number | null {
  let pos = 0;
  const peek = () => s[pos];
  const parseNumber = (): number | null => {
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos])) pos += 1;
    if (start === pos) return null;
    const value = Number(s.slice(start, pos));
    return Number.isFinite(value) ? value : null;
  };
  const parseFactor = (): number | null => {
    if (peek() === '(') {
      pos += 1;
      const value = parseExpr();
      if (value === null || peek() !== ')') return null;
      pos += 1;
      return value;
    }
    return parseNumber();
  };
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = s[pos];
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (op === '/') {
        if (right === 0) return null;
        left /= right;
      } else {
        left *= right;
      }
    }
    return left;
  };
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = s[pos];
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const result = parseExpr();
  return pos === s.length ? result : null;
}

/**
 * Parse user input into integer minor units. Accepts plain amounts ("12.50")
 * AND arithmetic ("1240/3", "740+120") — splitting apps live on quick math.
 * Null if invalid, non-positive, or out of range.
 */
export function parseAmountToCents(input: string, currency: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '');
  const digits = currencyDigits(currency);
  let cents: number;
  if (/[+\-*/()]/.test(cleaned)) {
    const value = evaluateExpression(cleaned);
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    // The tiny epsilon counters binary representation error (e.g. 2.01/2 is
    // 1.00499…95 in floats) so true half-cent results round half-up. It can
    // only flip values within 1e-7 of a boundary — the float-error zone itself.
    cents = Math.round(value * 10 ** digits + 1e-7);
  } else {
    // Plain amounts parse with string/integer math only — no float can appear.
    const parsed = parseDecimalToMinor(cleaned, digits);
    if (parsed === null) return null;
    cents = parsed;
  }
  return cents >= 1 && cents <= MAX_CENTS ? cents : null;
}

/**
 * Exact plain-decimal → minor units with half-up rounding; pure string/integer
 * math so "1.005" is 101 in a 2-digit currency (floats say 100). Accepts
 * ".5"; rejects anything else non-numeric. No range clamping here.
 */
export function parseDecimalToMinor(cleaned: string, digits: number): number | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1];
  const frac = match[2] ?? '';
  if (whole === '' && frac === '') return null;
  if (whole.length > 12) return null;
  const fracPadded = frac.padEnd(digits + 1, '0');
  const scaled =
    Number(whole || '0') * 10 ** digits + (digits > 0 ? Number(fracPadded.slice(0, digits)) : 0);
  const roundUp = Number(fracPadded[digits] ?? '0') >= 5 ? 1 : 0;
  return scaled + roundUp;
}

export interface OwedSplit {
  userId: number;
  owedCents: number;
}

/**
 * Split evenly; the remainder goes one cent at a time to the earliest users in
 * the given order, so results are deterministic and always sum exactly.
 */
export function splitEqual(amountCents: number, userIds: number[]): OwedSplit[] {
  if (userIds.length === 0) return [];
  const base = Math.floor(amountCents / userIds.length);
  const remainder = amountCents - base * userIds.length;
  return userIds.map((userId, i) => ({ userId, owedCents: base + (i < remainder ? 1 : 0) }));
}

export interface WeightEntry {
  userId: number;
  weight: number;
}

/**
 * Largest-remainder split by arbitrary positive weights (shares or percents).
 * Guaranteed to sum exactly to amountCents.
 */
export function splitByWeights(amountCents: number, entries: WeightEntry[]): OwedSplit[] {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (entries.length === 0 || total <= 0) return [];
  const exact = entries.map((e) => (amountCents * e.weight) / total);
  const floors = exact.map(Math.floor);
  let remaining = amountCents - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = entries.map((e, i) => ({ userId: e.userId, owedCents: floors[i] }));
  for (const { i } of order) {
    if (remaining <= 0) break;
    result[i].owedCents += 1;
    remaining -= 1;
  }
  return result;
}
