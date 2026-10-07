import { useState } from 'react';
import { CloudOff, History, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useOnline } from '@/components/layout/OfflineBanner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatDateSafe } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { useExpenseRevisions, useRestoreExpense } from '@/lib/queries';
import { describeRevisions, snapshotOf, type RevisionLine } from '@/lib/revisions';
import { relativeTime, useNameOf } from '@/lib/use-name-of';
import type { Expense, ExpenseSnapshot } from '@/lib/types';

export interface RestoreTarget {
  expenseId: number;
  revision: number;
  description: string;
  /** What the expense will look like afterwards (for the confirm copy). */
  snapshot: ExpenseSnapshot;
  expectedUpdatedAt: string;
  /** Undelete (the expense is currently deleted) vs revert. */
  undelete: boolean;
}

/**
 * Confirm + run a restore. Restoring re-applies an old split, so balances —
 * including ones already settled — can move; the copy says so plainly.
 */
export function RestoreConfirm({
  target,
  onOpenChange,
  onRestored,
}: {
  target: RestoreTarget | null;
  onOpenChange: (open: boolean) => void;
  onRestored?: (expense: Expense) => void;
}) {
  const restore = useRestoreExpense();
  const run = () => {
    if (!target) return;
    restore.mutate(
      {
        id: target.expenseId,
        revision: target.revision,
        expectedUpdatedAt: target.expectedUpdatedAt,
      },
      {
        onSuccess: (expense) => {
          toast(`Restored “${expense.description}”`);
          onOpenChange(false);
          onRestored?.(expense);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };
  const snap = target?.snapshot;
  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target?.undelete ? 'Restore this expense?' : 'Restore this version?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {snap
              ? `“${target.description}” comes back as ${formatMoney(
                  snap.amountCents,
                  snap.currency,
                )} on ${formatDateSafe(snap.date, 'MMM d, yyyy', snap.date)}. `
              : null}
            Everyone in it will see their balances change — debts that were already settled up
            may reopen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
          <AlertDialogAction className="rounded-full" disabled={restore.isPending} onClick={run}>
            {restore.isPending ? <Spinner data-icon="inline-start" /> : null}
            Restore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Who changed what, newest first. `expense` is the live row (null `current`
 * state when it's deleted); every version that differs from the current state
 * can be restored, unless the row belongs to a settle-up.
 */
export default function ExpenseHistorySheet({
  open,
  onOpenChange,
  expense,
  deleted = false,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: Expense;
  /** The expense is currently deleted: any version brings it back. */
  deleted?: boolean;
  onRestored?: (expense: Expense) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full max-w-xl rounded-t-[28px]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2 text-xl">
            <History className="size-5" aria-hidden="true" />
            History
          </SheetTitle>
          <p className="truncate text-sm text-muted-foreground">{expense.description}</p>
        </SheetHeader>
        {open ? (
          <HistoryBody
            expense={expense}
            deleted={deleted}
            onRestored={(e) => {
              onOpenChange(false);
              onRestored?.(e);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function HistoryBody({
  expense,
  deleted,
  onRestored,
}: {
  expense: Expense;
  deleted: boolean;
  onRestored: (expense: Expense) => void;
}) {
  const online = useOnline();
  const { data, isPending, isError, error } = useExpenseRevisions(expense.id, true);
  const nameOf = useNameOf(data?.users);
  const [target, setTarget] = useState<RestoreTarget | null>(null);
  const userOf = (id: number) => data?.users.find((u) => u.id === id);
  const locked = expense.settlementBatchId != null;

  if (isPending) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        <Skeleton className="h-20 rounded-[20px]" />
        <Skeleton className="h-20 rounded-[20px]" />
      </div>
    );
  }
  if (isError) {
    return (
      <FieldDescription className="px-4 pb-8 text-center">
        {online
          ? errorMessage(error)
          : 'You’re offline — history loads when you’re back online.'}
      </FieldDescription>
    );
  }

  const lines = describeRevisions(data.revisions, nameOf, deleted ? null : snapshotOf(expense));
  const byRevision = new Map(data.revisions.map((r) => [r.revision, r]));
  const ask = (line: RevisionLine) => {
    const rev = byRevision.get(line.revision);
    if (!rev) return;
    setTarget({
      expenseId: expense.id,
      revision: rev.revision,
      description: rev.snapshot.description,
      snapshot: rev.snapshot,
      expectedUpdatedAt: expense.updatedAt,
      undelete: deleted,
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
      {locked ? (
        <FieldDescription className="pb-3">
          This payment is part of a settle-up — undo the settle-up instead of restoring a version.
        </FieldDescription>
      ) : !online ? (
        <FieldDescription className="flex items-center gap-1.5 pb-3">
          <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
          You’re offline — restoring needs a connection.
        </FieldDescription>
      ) : null}
      <ol className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
        {lines.map((line, i) => (
          <li key={line.revision} className="flex gap-3 py-4">
            <UserAvatar user={userOf(line.actorId)} size="sm" className="mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-sm leading-snug font-medium">{line.title}</p>
              {line.splitLines.length > 0 ? (
                <ul className="flex flex-col text-xs text-muted-foreground">
                  {line.splitLines.map((s) => (
                    <li key={s} className="tabular-nums">
                      {s}
                    </li>
                  ))}
                </ul>
              ) : null}
              <time
                dateTime={line.createdAt}
                title={formatDateSafe(line.createdAt, 'PPpp', '')}
                className="text-xs text-muted-foreground"
              >
                {i === 0 && !deleted ? 'Current · ' : ''}
                {relativeTime(line.createdAt)}
              </time>
              {line.restorable && !locked ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 self-start rounded-full"
                  disabled={!online}
                  onClick={() => ask(line)}
                >
                  <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  Restore this version
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <RestoreConfirm
        target={target}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        onRestored={onRestored}
      />
    </div>
  );
}
