import type { PickerOption } from '@/components/ui/picker-select';
import { currencySymbol } from '@/components/expense/money-input';
import { COMMON_CURRENCIES, CURRENCIES } from '@/lib/money';

function currencyDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Picker order: the given codes (the user's default, the current value),
 * then the common ones, then every other ISO currency A–Z. A current value
 * this browser doesn't list is kept so it can still be shown.
 */
export function orderedCurrencies(preferred: (string | null | undefined)[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...preferred, ...COMMON_CURRENCIES, ...CURRENCIES]) {
    if (c && /^[A-Z]{3}$/.test(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

const optionCache = new Map<string, PickerOption>();

function option(code: string): PickerOption {
  let o = optionCache.get(code);
  if (!o) {
    const symbol = currencySymbol(code);
    o = {
      value: code,
      label: code,
      sublabel: currencyDisplayName(code),
      leading: (
        <span
          aria-hidden="true"
          className={
            'flex size-9 shrink-0 items-center justify-center rounded-full bg-background font-medium ' +
            (symbol.length > 2 ? 'text-[11px]' : 'text-sm')
          }
        >
          {symbol}
        </span>
      ),
    };
    optionCache.set(code, o);
  }
  return o;
}

/** Picker rows for the currency choosers: symbol badge, code, full name. */
export function currencyPickerOptions(
  preferred: (string | null | undefined)[] = [],
): PickerOption[] {
  return orderedCurrencies(preferred).map(option);
}
