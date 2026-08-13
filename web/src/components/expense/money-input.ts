import { MAX_CENTS, currencyDigits } from '@/lib/money';

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
export function parseShareInput(raw: string, currency: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 10 ** currencyDigits(currency));
  return cents >= 0 && cents <= MAX_CENTS ? cents : null;
}

/** Parse a percent field into integer basis points (0..10000). Empty = 0. */
export function parsePercentInput(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const bp = Math.round(value * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Basis points → compact percent label (3333 → "33.33", 5000 → "50"). */
export function formatBp(bp: number): string {
  return String(parseFloat((bp / 100).toFixed(2)));
}

/** Local YYYY-MM-DD for <input type="date">. */
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
