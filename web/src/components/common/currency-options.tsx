import type { PickerOption } from '@/components/ui/picker-select';
import { currencySymbol } from '@/components/expense/money-input';
import { CURRENCIES } from '@/lib/money';

function currencyDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Picker rows for the currency choosers: symbol badge, code, full name. */
export function currencyPickerOptions(): PickerOption[] {
  return CURRENCIES.map((code) => ({
    value: code,
    label: code,
    sublabel: currencyDisplayName(code),
    leading: (
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-sm font-medium"
      >
        {currencySymbol(code)}
      </span>
    ),
  }));
}
