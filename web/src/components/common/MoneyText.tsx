import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';

/**
 * Formats integer minor units. With `signed`, positive renders in the "owed to
 * you" green and negative in the "you owe" clay (absolute value shown).
 */
export function MoneyText({
  cents,
  currency,
  signed = false,
  className,
}: {
  cents: number;
  currency: string;
  signed?: boolean;
  className?: string;
}) {
  const color = !signed || cents === 0 ? undefined : cents > 0 ? 'text-owed' : 'text-owing';
  return (
    <span className={cn('tabular-nums', color, className)}>
      {formatMoney(Math.abs(cents), currency)}
    </span>
  );
}
