import { useCallback } from 'react';
import { NumberTicker } from '@/components/ui/number-ticker';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';

/**
 * Formats integer minor units. With `signed`, positive renders in the "owed to
 * you" green and negative in the "you owe" clay (absolute value shown). With
 * `animate`, a changed amount counts to its new value (balances), and the
 * owe/owed color cross-fades.
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
