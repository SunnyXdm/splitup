/**
 * ISO 4217 currencies the server accepts: whatever this Node's ICU knows,
 * minus the non-money "X" codes (SDRs, Sucre) and withdrawn currencies whose
 * ICU name carries an end year ("Sierra Leonean Leone (1964—2022)").
 */
let allowed: Set<string> | null = null;

const NON_MONEY = new Set(['XDR', 'XSU', 'XUA', 'XBA', 'XBB', 'XBC', 'XBD', 'XTS', 'XXX']);

export function supportedCurrencies(): Set<string> {
  if (allowed) return allowed;
  const names = new Intl.DisplayNames('en', { type: 'currency' });
  allowed = new Set(
    Intl.supportedValuesOf('currency').filter(
      (c) => /^[A-Z]{3}$/.test(c) && !NON_MONEY.has(c) && !/\(\d{4}/.test(names.of(c) ?? ''),
    ),
  );
  return allowed;
}

export function isSupportedCurrency(code: string): boolean {
  return supportedCurrencies().has(code);
}

const digitsCache = new Map<string, number>();

/** Minor-unit digits (INR 2, JPY 0, BHD 3). Unknown codes fall back to 2. */
export function currencyDigits(code: string): number {
  let d = digitsCache.get(code);
  if (d === undefined) {
    try {
      d =
        new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(code, d);
  }
  return d;
}
