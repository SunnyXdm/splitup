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

const decimalCache = new Map<string, ',' | '.'>();

/** The decimal separator of a locale (default: the browser's), ',' or '.'. */
export function localeDecimalSeparator(locale?: string): ',' | '.' {
  const key = locale ?? '';
  let sep = decimalCache.get(key);
  if (sep === undefined) {
    let found = '.';
    try {
      found =
        new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')
          ?.value ?? '.';
    } catch {
      // unknown locale tag → fall back to '.'
    }
    sep = found === ',' ? ',' : '.';
    decimalCache.set(key, sep);
  }
  return sep;
}

/**
 * "1", "12", "123" followed by one or more ",ddd" groups (sep = the grouping
 * char) — or, with a comma, Indian lakh/crore grouping: 1–2 leading digits,
 * 2-digit groups, then a final 3-digit group ("2,81,152", "1,00,00,000").
 */
function isGrouped(s: string, sep: ',' | '.'): boolean {
  const parts = s.split(sep);
  if (parts.length < 2) return false;
  if (/^\d{1,3}$/.test(parts[0]) && parts.slice(1).every((p) => /^\d{3}$/.test(p))) return true;
  return sep === ',' && /^\d{1,2}(,\d{2})+,\d{3}$/.test(s);
}

/**
 * One numeric token ("12,50", "1,234.56", "1.234,56") → canonical "1234.56"
 * form, or null when malformed or AMBIGUOUS. Never guesses: "1,234" means
 * 1234 to an en-US user and 1.234 to a de-DE user, so a lone separator
 * followed by exactly three digits resolves by the locale's decimal
 * separator; a comma followed by 1–2 digits is always decimal (nobody groups
 * "12,50"), and grouping must form exact 3-digit groups.
 */
function normalizeNumberToken(token: string, localeDecimal: ',' | '.'): string | null {
  const hasComma = token.includes(',');
  const hasDot = token.includes('.');
  if (hasComma && hasDot) {
    // Both present: the LAST one is the decimal mark, the other must group.
    const decimal = token.lastIndexOf(',') > token.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    const at = token.lastIndexOf(decimal);
    const whole = token.slice(0, at);
    const frac = token.slice(at + 1);
    if (!/^\d*$/.test(frac) || !isGrouped(whole, group)) return null;
    return `${whole.split(group).join('')}.${frac}`;
  }
  const sep = hasComma ? ',' : hasDot ? '.' : null;
  if (sep === null) return /^\d+$/.test(token) ? token : null;
  const parts = token.split(sep);
  if (parts.length > 2) {
    // Several of the same separator can only be grouping ("1,234,567") —
    // and only when the locale doesn't use that char as its decimal mark.
    if (sep === localeDecimal || !isGrouped(token, sep)) return null;
    return parts.join('');
  }
  const [whole, frac] = parts;
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (frac.length >= 3 && sep !== localeDecimal) {
    // "1,234" in a '.'-decimal locale is grouping — but only as an exact
    // 3-digit group after 1–3 leading digits; "1234,567" / "1,2345" are
    // ambiguous, so reject them instead of guessing.
    return frac.length === 3 && /^\d{1,3}$/.test(whole) ? `${whole}${frac}` : null;
  }
  return `${whole}.${frac}`;
}

/**
 * User-typed amount text → canonical text ('.' decimal, no grouping, no
 * spaces), applied to every number in an arithmetic expression. Null when any
 * number is malformed or ambiguous. Exported for the "= €12.50" preview.
 */
export function normalizeAmountText(input: string, locale?: string): string | null {
  const compact = input.replace(/[\s\u00a0\u202f]/g, '');
  const localeDecimal = localeDecimalSeparator(locale);
  let failed = false;
  const out = compact.replace(/[\d.,]+/g, (token) => {
    const normalized = normalizeNumberToken(token, localeDecimal);
    if (normalized === null) failed = true;
    return normalized ?? '';
  });
  return failed ? null : out;
}

/**
 * Minor units → an editable amount WITH digit grouping in the user's locale
 * ("2,81,152.66" in en-IN, "281.152,66" in de-DE). Falls back to the plain
 * form when the parser couldn't read the grouped text back exactly.
 */
export function formatAmountInput(cents: number, currency: string, locale?: string): string {
  const digits = currencyDigits(currency);
  const plain = (cents / 10 ** digits).toFixed(digits);
  let grouped: string;
  try {
    grouped = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true,
    }).format(cents / 10 ** digits);
  } catch {
    return plain;
  }
  const back = parseAmountToCents(grouped, currency, locale);
  return back === cents ? grouped : plain;
}

/** True when the text is already a plain canonical amount ("12", "12.50"). */
export function isCanonicalAmount(input: string): boolean {
  return /^\d+(\.\d*)?$|^\.\d+$/.test(input.trim());
}

/**
 * Parse user input into integer minor units. Accepts plain amounts ("12.50",
 * "12,50", "1,234.50") AND arithmetic ("1240/3", "740+120") — splitting apps
 * live on quick math. Null if invalid, ambiguous, non-positive, or out of
 * range.
 */
export function parseAmountToCents(
  input: string,
  currency: string,
  locale?: string,
): number | null {
  const cleaned = normalizeAmountText(input, locale);
  if (cleaned === null) return null;
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
