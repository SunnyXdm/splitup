import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { addMonths, endOfMonth, format, isValid, parse } from 'date-fns';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import ExpenseForm from '@/components/expense/ExpenseForm';
import SpendingSummary from '@/components/summary/SpendingSummary';
import { filtersToParams, DEFAULT_FILTERS } from '@/lib/search';
import { firstMonth, personalSummary } from '@/lib/summary';
import { useSyncData } from '@/lib/queries';
import type { Expense } from '@/lib/types';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';

const MONTH = /^\d{4}-\d{2}$/;

function parseMonth(raw: string | null): Date | null {
  if (!raw || !MONTH.test(raw)) return null;
  const d = parse(`${raw}-01`, 'yyyy-MM-dd', new Date());
  return isValid(d) ? d : null;
}

/** Monthly spending across everything I'm part of: /insights?month=YYYY-MM. */
export default function Insights() {
  const { data: sync } = useSyncData();
  const [params] = useSearchParams();
  const navigate = useOverlayNavigate();
  const [editing, setEditing] = useState<Expense | undefined>();
  const [expenseOpen, setExpenseOpen] = useState(false);

  if (!sync) {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="h-12 w-56 rounded-full" />
        <Skeleton className="h-56 rounded-[28px]" />
      </div>
    );
  }

  const thisMonth = format(new Date(), 'yyyy-MM');
  const monthStart = parseMonth(params.get('month')) ?? parseMonth(thisMonth)!;
  const month = format(monthStart, 'yyyy-MM');
  const earliest = firstMonth(sync) ?? thisMonth;
  const range = {
    from: format(monthStart, 'yyyy-MM-dd'),
    to: format(endOfMonth(monthStart), 'yyyy-MM-dd'),
  };
  const summaries = personalSummary(sync, range);

  // Stepping months replaces the entry: Back leaves Insights, not the month.
  const go = (delta: number) => {
    const next = format(addMonths(monthStart, delta), 'yyyy-MM');
    navigate({ search: next === thisMonth ? '' : `?month=${next}` }, { replace: true });
  };
  const searchLink = `/search?${filtersToParams({
    ...DEFAULT_FILTERS,
    range: 'custom',
    from: range.from,
    to: range.to,
    type: 'expenses',
  }).toString()}`;

  const directFriendId =
    editing && editing.groupId === null
      ? editing.shares.find((s) => s.userId !== sync.me.id)?.userId
      : undefined;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <header className="flex flex-col gap-3">
        <span className="eyebrow">Insights</span>
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-2xl font-medium tracking-tight sm:text-3xl">
            {format(monthStart, 'MMMM yyyy')}
          </h1>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-10 rounded-full"
            aria-label="Previous month"
            disabled={month <= earliest}
            onClick={() => go(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-10 rounded-full"
            aria-label="Next month"
            disabled={month >= thisMonth}
            onClick={() => go(1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Your share of every expense you were part of, in groups and one-to-one. Settle-up payments
          aren&rsquo;t spending, so they&rsquo;re counted separately.
        </p>
      </header>

      <SpendingSummary
        sync={sync}
        summaries={summaries}
        scope="personal"
        onSelect={(e) => {
          setEditing(e);
          setExpenseOpen(true);
        }}
        emptyText={`Nothing you were part of in ${format(monthStart, 'MMMM')}.`}
      />

      {summaries.some((s) => s.expenseCount > 0) ? (
        <Button
          variant="outline"
          className="h-11 rounded-full"
          render={<Link to={searchLink} />}
          nativeButton={false}
        >
          <Search data-icon="inline-start" aria-hidden="true" />
          See this month&rsquo;s expenses
        </Button>
      ) : null}

      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={editing?.groupId ?? null}
        expense={editing}
        friendId={directFriendId}
      />
    </div>
  );
}
