import { MAX_CENTS, currencyDigits, normalizeAmountText, parseDecimalToMinor } from '@/lib/money';

const symbolCache = new Map<string, string>();

/** Narrow currency symbol ("$", "₹"); falls back to the code itself. */
export function currencySymbol(currency: string): string {
  let sym = symbolCache.get(currency);
  if (sym === undefined) {
    try {
      const parts = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      }).formatToParts(0);
      sym = parts.find((p) => p.type === 'currency')?.value ?? currency;
    } catch {
      sym = currency;
    }
    symbolCache.set(currency, sym);
  }
  return sym;
}

/** Integer minor units → editable decimal string (1250 → "12.50"). */
export function centsToInput(cents: number, currency: string): string {
  const digits = currencyDigits(currency);
  return (cents / 10 ** digits).toFixed(digits);
}

/**
 * Parse a per-member amount field into minor units. Empty counts as 0
 * (unlike parseAmountToCents, which requires a positive total).
 */
export function parseShareInput(raw: string, currency: string, locale?: string): number | null {
  // Same locale-aware separator handling as the total ("12,50" is 12.50).
  const cleaned = normalizeAmountText(raw, locale);
  if (cleaned === null) return null;
  if (cleaned === '') return 0;
  // Same exact string/integer parsing as the total field, so identical text
  // can never round differently between the two ("1.005" was 101 vs 100).
  const cents = parseDecimalToMinor(cleaned, currencyDigits(currency));
  if (cents === null) return null;
  return cents >= 0 && cents <= MAX_CENTS ? cents : null;
}

/** Parse a percent field into integer basis points (0..10000). Empty = 0. */
export function parsePercentInput(raw: string, locale?: string): number | null {
  const cleaned = normalizeAmountText(raw, locale);
  if (cleaned === null) return null;
  if (cleaned === '') return 0;
  const bp = parseDecimalToMinor(cleaned, 2);
  if (bp === null) return null;
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Basis points → compact percent label (3333 → "33.33", 5000 → "50"). */
export function formatBp(bp: number): string {
  return String(parseFloat((bp / 100).toFixed(2)));
}

/** Local YYYY-MM-DD for <input type="date">. */
export function todayISO(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today" / "Yesterday" / "Tomorrow", else null — said beside a date field. */
export function relativeDay(date: string, today: string = todayISO()): string | null {
  if (date === today) return 'Today';
  const [y, m, d] = today.split('-').map(Number);
  const shift = (days: number) => todayISO(new Date(y, m - 1, d + days));
  if (date === shift(-1)) return 'Yesterday';
  if (date === shift(1)) return 'Tomorrow';
  return null;
}
