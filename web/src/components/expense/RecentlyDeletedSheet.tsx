import { useState } from 'react';
import { ArchiveRestore, CloudOff, History } from 'lucide-react';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { useDeletedExpenses, type DeletedScope } from '@/lib/queries';
import { snapshotOf } from '@/lib/revisions';
import type { DeletedExpense } from '@/lib/types';
import { relativeTime, useNameOf } from '@/lib/use-name-of';
import ExpenseHistorySheet, { RestoreConfirm, type RestoreTarget } from './ExpenseHistorySheet';

/**
 * Expenses deleted in the last 90 days in one group / with one friend. Each
 * can be brought back as it was when deleted, or opened to pick an older
 * version from its history.
 */
export default function RecentlyDeletedSheet({
  open,
  onOpenChange,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: DeletedScope;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full max-w-xl rounded-t-[28px]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-xl">Recently deleted</SheetTitle>
          <p className="text-sm text-muted-foreground">
            Expenses deleted in the last 90 days. Restoring one puts it back in everyone’s
            balances.
          </p>
        </SheetHeader>
        {open ? <DeletedBody scope={scope} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function DeletedBody({ scope }: { scope: DeletedScope }) {
  const online = useOnline();
  const { data, isPending, isError, error } = useDeletedExpenses(scope, true);
  const nameOf = useNameOf(data?.users);
  const [target, setTarget] = useState<RestoreTarget | null>(null);
  const [historyOf, setHistoryOf] = useState<DeletedExpense | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (isPending) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        <Skeleton className="h-16 rounded-[20px]" />
        <Skeleton className="h-16 rounded-[20px]" />
      </div>
    );
  }
  if (isError) {
    return (
      <FieldDescription className="px-4 pb-8 text-center">
        {online
          ? errorMessage(error)
          : 'You’re offline — this list loads when you’re back online.'}
      </FieldDescription>
    );
  }

  const ask = (e: DeletedExpense) =>
    setTarget({
      expenseId: e.id,
      revision: e.revision,
      description: e.description,
      snapshot: snapshotOf(e),
      expectedUpdatedAt: e.updatedAt,
      undelete: true,
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
      {!online ? (
        <FieldDescription className="flex items-center gap-1.5 pb-3">
          <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
          You’re offline — restoring needs a connection.
        </FieldDescription>
      ) : null}
      {data.expenses.length === 0 ? (
        <FieldDescription className="py-6 text-center">Nothing deleted recently.</FieldDescription>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
          {data.expenses.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background">
                  <CategoryIcon category={e.category} className="size-4 text-foreground/70" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{e.description}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {e.deletedBy !== null ? `${nameOf(e.deletedBy)} deleted it ` : 'Deleted '}
                    {relativeTime(e.deletedAt)}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  {formatMoney(e.amountCents, e.currency)}
                </span>
              </div>
              <div className="flex gap-2 pl-13">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={!online}
                  onClick={() => ask(e)}
                >
                  <ArchiveRestore data-icon="inline-start" aria-hidden="true" />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full text-muted-foreground"
                  onClick={() => {
                    setHistoryOf(e);
                    setHistoryOpen(true);
                  }}
                >
                  <History data-icon="inline-start" aria-hidden="true" />
                  History
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <RestoreConfirm
        target={target}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
      />
      {historyOf ? (
        <ExpenseHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          expense={historyOf}
          deleted
        />
      ) : null}
    </div>
  );
}
