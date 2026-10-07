import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ReceiptText } from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ExpenseDetailSheets } from '@/components/expense/ExpenseDetailSheet';
import ExpenseForm from '@/components/expense/ExpenseForm';
import { PageHeader } from '@/components/layout/PageHeader';
import FilteredHistory from '@/components/search/FilteredHistory';
import { useSyncData } from '@/lib/queries';
import type { Expense } from '@/lib/types';
import { useExpenseDetail } from '@/lib/use-expense-detail';

/** Global search across every expense and payment on this device (works offline). */
export default function Search() {
  const { data: sync } = useSyncData();
  const [params] = useSearchParams();
  const [editing, setEditing] = useState<Expense | undefined>();
  const [expenseOpen, setExpenseOpen] = useState(false);
  // A result opens its detail (or a payment's receipt) first; Edit from there.
  const detail = useExpenseDetail(sync);

  const people = useMemo(
    () =>
      sync
        ? sync.users.filter((u) => u.id !== sync.me.id).sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [sync],
  );

  if (!sync) {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <Skeleton className="h-11 w-40 rounded-full" />
        <Skeleton className="h-12 rounded-full" />
        <Skeleton className="h-40 rounded-[28px]" />
      </div>
    );
  }

  // A 1:1 expense edits as one with the other person in it.
  const directFriendId =
    editing && editing.groupId === null
      ? editing.shares.find((s) => s.userId !== sync.me.id)?.userId
      : undefined;

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Search" />
      {/* Settle-ups fold into one row per payment (ExpenseHistory's default);
          a filter that keeps only part of one shows just that part. */}
      <FilteredHistory
        sync={sync}
        expenses={sync.expenses}
        people={people}
        showGroupTag
        showGroupFilter
        // Arriving fresh: straight to typing. Arriving with a query (Back,
        // reload, a link from Insights): don't pop the keyboard over results.
        autoFocus={params.toString() === ''}
        placeholder="Search all expenses"
        onSelect={detail.open}
        empty={
          <Empty className="bg-card rounded-[28px] py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="rounded-full">
                <ReceiptText />
              </EmptyMedia>
              <EmptyTitle>Nothing to search yet</EmptyTitle>
              <EmptyDescription>
                Expenses and payments you add will be searchable here — even offline.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      {/* editing is kept after close so the sheet doesn't flip mid-animation. */}
      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={editing?.groupId ?? null}
        expense={editing}
        friendId={directFriendId}
      />
      <ExpenseDetailSheets
        detail={detail}
        onEdit={(e) => {
          setEditing(e);
          setExpenseOpen(true);
        }}
      />
    </div>
  );
}
