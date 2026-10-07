import { MoneyText } from '@/components/common/MoneyText';
import type { NetBalance } from '@/lib/balances';

/** Right-aligned "you owe / you are owed" stack for a group row. */
export function MyGroupBalance({ balances }: { balances: NetBalance[] }) {
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      {balances.length === 0 ? (
        <span className="text-sm text-muted-foreground">settled up</span>
      ) : (
        balances.map((b) => (
          <span key={b.currency} className="flex flex-col items-end">
            <span className="text-[11px] text-muted-foreground">
              {b.netCents > 0 ? 'you are owed' : 'you owe'}
            </span>
            <MoneyText
              signed
              cents={b.netCents}
              currency={b.currency}
              className="text-sm font-medium"
            />
          </span>
        ))
      )}
    </span>
  );
}
