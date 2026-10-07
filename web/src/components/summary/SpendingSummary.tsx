import { Link } from 'react-router';
import { ChartPie, ChevronRight } from 'lucide-react';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { CATEGORY_META } from '@/lib/categories';
import { formatDateSafe } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { DEFAULT_FILTERS, filtersToParams, type DayRange } from '@/lib/search';
import type { CurrencySummary } from '@/lib/summary';
import type { Category, Expense, SyncData } from '@/lib/types';

interface SpendingSummaryProps {
  sync: SyncData;
  summaries: CurrencySummary[];
  /** 'group' = one group's spending; 'personal' = everything I'm part of. */
  scope: 'group' | 'personal';
  /** The period shown — category rows open Search filtered to it. */
  range?: DayRange;
  /** Group scope: category rows search within this group. */
  groupId?: number;
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
  range,
  groupId,
  onSelect,
  emptyText = 'Nothing was spent in this period.',
}: SpendingSummaryProps) {
  if (summaries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card bg-card px-6 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-background text-muted-foreground">
          <ChartPie className="size-5" aria-hidden="true" />
        </span>
        <p className="font-medium">No spending yet</p>
        <p className="text-sm text-muted-foreground">{emptyText}</p>
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
          categoryLink={(category) => categorySearch(category, range, groupId)}
          onSelect={onSelect}
          index={i}
        />
      ))}
    </div>
  );
}

/** /search?cat=…&range=custom&from=…&to=…&type=expenses[&group=…] */
function categorySearch(category: Category, range?: DayRange, groupId?: number): string {
  const hasRange = range !== undefined && (range.from !== null || range.to !== null);
  const params = filtersToParams({
    ...DEFAULT_FILTERS,
    category,
    type: 'expenses',
    range: hasRange ? 'custom' : 'all',
    from: hasRange ? range.from : null,
    to: hasRange ? range.to : null,
    group: groupId ?? 'all',
  });
  return `/search?${params.toString()}`;
}

function CurrencySection({
  sync,
  summary: s,
  scope,
  heading,
  categoryLink,
  onSelect,
  index,
}: {
  sync: SyncData;
  summary: CurrencySummary;
  scope: 'group' | 'personal';
  heading: string | null;
  categoryLink: (category: Category) => string;
  onSelect?: (expense: Expense) => void;
  index: number;
}) {
  const fmt = (cents: number) => formatMoney(cents, s.currency);
  const totalLabel = scope === 'group' ? 'Group spending' : 'Shared bills total';
  const hasPayments = s.paymentsSentCents > 0 || s.paymentsReceivedCents > 0;
  // Personal: what cost ME most. Group: the group's biggest bills.
  const top = scope === 'personal' ? s.topMine : s.top;

  return (
    <section
      aria-label={heading ? `${heading} summary` : undefined}
      className="flex animate-in flex-col gap-3 duration-300 fill-mode-backwards fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
      style={{ animationDelay: `${Math.min(index, 4) * 60}ms` }}
    >
      {heading ? <h2 className="eyebrow">{heading}</h2> : null}

      <div className="flex flex-col gap-5 rounded-card bg-card p-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">
            {scope === 'group' ? 'What it cost you' : 'Your share'}
          </span>
          <p className="text-[32px] leading-tight font-medium tracking-[-0.02em] tabular-nums">
            {fmt(s.myShareCents)}
          </p>
          <p className="text-sm text-muted-foreground">
            {s.expenseCount === 0
              ? 'No expenses — only payments in this period.'
              : `Your share of ${s.expenseCount} ${s.expenseCount === 1 ? 'expense' : 'expenses'}, whoever paid.`}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border/60 pt-5">
          <Stat label={totalLabel} value={fmt(s.totalCents)} />
          <Stat label="You paid" value={fmt(s.myPaidCents)} />
        </dl>
        {hasPayments ? (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-5">
            <div className="flex flex-col gap-0.5">
              <h3 className="font-medium">
                {scope === 'group' ? 'Settlement entries in this group' : 'Settle-up payments'}
              </h3>
              <p className="text-sm text-muted-foreground">
                {scope === 'group'
                  ? 'Each settle-up’s part recorded in this group, offsets included — not separate transfers.'
                  : 'Money that changed hands to settle up. Not spending, so not in your share.'}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
              <Stat label="You paid" value={fmt(s.paymentsSentCents)} />
              <Stat label="You received" value={fmt(s.paymentsReceivedCents)} />
            </dl>
          </div>
        ) : null}
      </div>

      {s.categories.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-card bg-card px-3 pt-5 pb-2">
          <h3 className="px-3 pb-1 font-medium">Your share by category</h3>
          <ul className="flex flex-col">
            {s.categories.map((c) => {
              const pct = s.myShareCents > 0 ? (c.cents / s.myShareCents) * 100 : 0;
              const label = (CATEGORY_META[c.category] ?? CATEGORY_META.general).label;
              return (
                <li key={c.category}>
                  <Link
                    to={categoryLink(c.category)}
                    aria-label={`${label}: ${fmt(c.cents)}, ${Math.round(pct)}% — see these expenses`}
                    className="flex flex-col gap-2 rounded-panel px-3 py-3 outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-focus-ring"
                  >
                    <span className="flex items-center gap-2">
                      <CategoryIcon category={c.category} className="size-4 text-foreground/70" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="font-medium tabular-nums">{fmt(c.cents)}</span>
                      <span className="w-11 text-right text-sm text-muted-foreground tabular-nums">
                        {Math.round(pct)}%
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </span>
                    <span
                      className="h-2 overflow-hidden rounded-full bg-background"
                      aria-hidden="true"
                    >
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(pct, 1.5)}%` }}
                      />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {top.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-card bg-card px-4 pt-5 pb-1">
          <h3 className="px-2 font-medium">
            {scope === 'personal' ? 'Your biggest shares' : 'Largest bills'}
          </h3>
          <ol className="flex flex-col divide-y divide-border/60">
            {top.map((e) => (
              <li key={e.id}>
                <TopRow sync={sync} expense={e} scope={scope} onSelect={onSelect} />
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
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function TopRow({
  sync,
  expense: e,
  scope,
  onSelect,
}: {
  sync: SyncData;
  expense: Expense;
  scope: 'group' | 'personal';
  onSelect?: (expense: Expense) => void;
}) {
  const meId = sync.me.id;
  const mine = e.shares.find((s) => s.userId === meId);
  const myShare = mine?.owedCents ?? 0;
  const payers = e.shares.filter((s) => s.paidCents > 0);
  const payer =
    payers.length === 1
      ? payers[0].userId === meId
        ? 'You'
        : (sync.users.find((u) => u.id === payers[0].userId)?.name ?? 'Someone')
      : `${payers.length} people`;
  // Personal ranks by my share, so it leads; group ranks by the whole bill.
  const lead = scope === 'personal' ? myShare : e.amountCents;
  const sub =
    scope === 'personal'
      ? `of ${formatMoney(e.amountCents, e.currency)}`
      : myShare > 0
        ? `your share ${formatMoney(myShare, e.currency)}`
        : 'not your share';
  const content = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background">
        <CategoryIcon category={e.category} className="size-4 text-foreground/70" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{e.description}</span>
        <span className="truncate text-sm text-muted-foreground">
          {formatDateSafe(e.date, 'MMM d', '—')} · {payer} paid
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-medium tabular-nums">{formatMoney(lead, e.currency)}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{sub}</span>
      </span>
    </>
  );
  const clickable = onSelect !== undefined && e.id > 0;
  return clickable ? (
    <button
      type="button"
      onClick={() => onSelect(e)}
      className="flex min-h-16 w-full items-center gap-3 px-2 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-h-16 items-center gap-3 px-2 py-3">{content}</div>
  );
}
