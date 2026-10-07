import { useCallback, useState, type ReactNode } from 'react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';

/**
 * Formats integer minor units. With `signed`, positive renders in the "owed to
 * you" green and negative in the "you owe" clay (absolute value shown). With
 * `animate`, a changed amount counts to its new value (balances) while its
 * direction stays the same; a flip swaps it with a short crossfade.
 */
export function MoneyText({
  cents,
  currency,
  signed = false,
  animate = false,
  className,
}: {
  cents: number;
  currency: string;
  signed?: boolean;
  animate?: boolean;
  className?: string;
}) {
  const color = !signed || cents === 0 ? undefined : cents > 0 ? 'text-owed' : 'text-owing';
  if (animate) {
    return (
      <AnimatedMoney
        cents={cents}
        currency={currency}
        className={cn('transition-colors duration-(--dur-base)', color, className)}
      />
    );
  }
  return (
    <span className={cn('tabular-nums', color, className)}>
      {formatMoney(Math.abs(cents), currency)}
    </span>
  );
}

/**
 * Money that eases between values when it changes. The formatter is memoized
 * on the currency so the ticker never restarts on an unrelated re-render.
 * It never counts across a sign flip or a currency change (see NumberTicker).
 */
export function AnimatedMoney({
  cents,
  currency,
  animateOnMount = false,
  className,
}: {
  cents: number;
  currency: string;
  animateOnMount?: boolean;
  className?: string;
}) {
  const format = useCallback(
    (v: number) => formatMoney(Math.abs(Math.round(v)), currency),
    [currency],
  );
  return (
    <NumberTicker
      value={cents}
      format={format}
      animateOnMount={animateOnMount}
      className={cn('inline', className)}
    />
  );
}

/**
 * A direction word and its amount, as one unit: "owes you ₹450". The amount
 * counts only while the direction and currency stay the same; when either
 * changes, the whole phrase (words + value) is replaced at once with a short
 * crossfade — never "you owe" next to a number still counting from a credit.
 */
export function AnimatedBalance({
  cents,
  currency,
  label,
  animateOnMount = false,
  className,
  amountClassName,
}: {
  /** Signed: + = owed to you, − = you owe. */
  cents: number;
  currency: string;
  /** The words before the amount for this direction ("owes you ", "you owe "). */
  label: (direction: 'owed' | 'owe' | 'none') => ReactNode;
  animateOnMount?: boolean;
  className?: string;
  amountClassName?: string;
}) {
  const direction = cents > 0 ? 'owed' : cents < 0 ? 'owe' : 'none';
  const key = `${direction}:${currency}`;
  // The first phrase shows as-is; only later swaps fade in.
  const [firstKey] = useState(key);
  const swapped = key !== firstKey;
  return (
    <span
      key={key}
      className={cn(
        swapped && 'animate-in duration-200 fade-in motion-reduce:animate-none',
        className,
      )}
    >
      {label(direction)}
      <AnimatedMoney
        cents={cents}
        currency={currency}
        animateOnMount={animateOnMount}
        className={amountClassName}
      />
    </span>
  );
}
