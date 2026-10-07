import { ChartPie } from 'lucide-react';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { CATEGORY_META } from '@/lib/categories';
import { formatDateSafe } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { CurrencySummary } from '@/lib/summary';
import type { Expense, SyncData } from '@/lib/types';

interface SpendingSummaryProps {
  sync: SyncData;
  summaries: CurrencySummary[];
  /** 'group' = one group's spending; 'personal' = everything I'm part of. */
  scope: 'group' | 'personal';
  onSelect?: (expense: Expense) => void;
  /** Empty-state copy for a period with nothing in it. */
  emptyText?: string;
}

/**
 * Per-currency spending: what it cost me (my share — consumption, not my
 * balance), what I paid, payments, my share by category, and the biggest
 * expenses. Currencies are separate sections, never added together.
 */
export default function SpendingSummary({
  sync,
  summaries,
  scope,
  onSelect,
  emptyText = 'Nothing was spent in this period.',
}: SpendingSummaryProps) {
  if (summaries.length === 0) {
    return (
      <div className="bg-card flex flex-col items-center gap-3 rounded-[28px] px-6 py-12 text-center">
        <span className="bg-background text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <ChartPie className="size-5" aria-hidden="true" />
        </span>
        <p className="font-medium">No spending yet</p>
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      </div>
    );
  }
  const multi = summaries.length > 1;
  return (
    <div className="flex flex-col gap-8">
      {summaries.map((s, i) => (
        <CurrencySection
          key={s.currency}
          sync={sync}
          summary={s}
          scope={scope}
          heading={multi ? s.currency : null}
          onSelect={onSelect}
          index={i}
        />
      ))}
    </div>
  );
}

function CurrencySection({
  sync,
  summary: s,
  scope,
  heading,
  onSelect,
  index,
}: {
  sync: SyncData;
  summary: CurrencySummary;
  scope: 'group' | 'personal';
  heading: string | null;
  onSelect?: (expense: Expense) => void;
  index: number;
}) {
  const fmt = (cents: number) => formatMoney(cents, s.currency);
  const totalLabel = scope === 'group' ? 'Group spending' : 'Shared bills total';
  const hasPayments = s.paymentsSentCents > 0 || s.paymentsReceivedCents > 0;

  return (
    <section
      aria-label={heading ? `${heading} summary` : undefined}
      className="animate-in fill-mode-backwards fade-in slide-in-from-bottom-2 flex flex-col gap-3 duration-300 motion-reduce:animate-none"
      style={{ animationDelay: `${Math.min(index, 4) * 60}ms` }}
    >
      {heading ? <h2 className="eyebrow">{heading}</h2> : null}

      <div className="bg-card flex flex-col gap-5 rounded-[28px] p-6">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-sm">
            {scope === 'group' ? 'What it cost you' : 'Your share'}
          </span>
          <p className="text-3xl font-medium tracking-tight tabular-nums sm:text-4xl">
            {fmt(s.myShareCents)}
          </p>
          <p className="text-muted-foreground text-sm">
            {s.expenseCount === 0
              ? 'No expenses — only payments in this period.'
              : `Your share of ${s.expenseCount} ${s.expenseCount === 1 ? 'expense' : 'expenses'}, whoever paid.`}
          </p>
        </div>
        <dl className="border-border/60 grid grid-cols-2 gap-x-4 gap-y-4 border-t pt-5">
          <Stat label={totalLabel} value={fmt(s.totalCents)} />
          <Stat label="You paid" value={fmt(s.myPaidCents)} />
          {hasPayments ? (
            <>
              <Stat label="Payments you sent" value={fmt(s.paymentsSentCents)} />
              <Stat label="Payments you received" value={fmt(s.paymentsReceivedCents)} />
            </>
          ) : null}
        </dl>
      </div>

      {s.categories.length > 0 ? (
        <div className="bg-card flex flex-col gap-4 rounded-[28px] p-6">
          <h3 className="text-sm font-medium">Your share by category</h3>
          <ul className="flex flex-col gap-4">
            {s.categories.map((c) => {
              const pct = s.myShareCents > 0 ? (c.cents / s.myShareCents) * 100 : 0;
              const label = (CATEGORY_META[c.category] ?? CATEGORY_META.general).label;
              return (
                <li key={c.category} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <CategoryIcon category={c.category} className="text-foreground/70 size-4" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="tabular-nums">{fmt(c.cents)}</span>
                    <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
                      {Math.round(pct)}%
                    </span>
                  </div>
                  <div
                    className="bg-background h-2 overflow-hidden rounded-full"
                    aria-hidden="true"
                  >
                    <div
                      className="bg-primary h-full rounded-full"
                      style={{ width: `${Math.max(pct, 1.5)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {s.top.length > 0 ? (
        <div className="bg-card flex flex-col gap-1 rounded-[28px] px-4 pt-5 pb-1">
          <h3 className="px-2 text-sm font-medium">Biggest expenses</h3>
          <ol className="divide-border/60 flex flex-col divide-y">
            {s.top.map((e) => (
              <li key={e.id}>
                <TopRow sync={sync} expense={e} onSelect={onSelect} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function TopRow({
  sync,
  expense: e,
  onSelect,
}: {
  sync: SyncData;
  expense: Expense;
  onSelect?: (expense: Expense) => void;
}) {
  const meId = sync.me.id;
  const mine = e.shares.find((s) => s.userId === meId);
  const payers = e.shares.filter((s) => s.paidCents > 0);
  const payer =
    payers.length === 1
      ? payers[0].userId === meId
        ? 'You'
        : (sync.users.find((u) => u.id === payers[0].userId)?.name ?? 'Someone')
      : `${payers.length} people`;
  const content = (
    <>
      <span className="bg-background flex size-10 shrink-0 items-center justify-center rounded-full">
        <CategoryIcon category={e.category} className="text-foreground/70 size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{e.description}</span>
        <span className="text-muted-foreground truncate text-xs">
          {formatDateSafe(e.date, 'MMM d', '—')} · {payer} paid
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-sm font-medium tabular-nums">
          {formatMoney(e.amountCents, e.currency)}
        </span>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {mine && mine.owedCents > 0
            ? `your share ${formatMoney(mine.owedCents, e.currency)}`
            : 'not your share'}
        </span>
      </span>
    </>
  );
  const clickable = onSelect !== undefined && e.id > 0;
  return clickable ? (
    <button
      type="button"
      onClick={() => onSelect(e)}
      className="focus-visible:ring-focus-ring flex min-h-16 w-full items-center gap-3 px-2 py-3 text-left outline-none focus-visible:ring-2"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-h-16 items-center gap-3 px-2 py-3">{content}</div>
  );
}
