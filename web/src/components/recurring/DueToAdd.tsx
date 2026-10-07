import { useState } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Check, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import ExpenseForm from '@/components/expense/ExpenseForm';
import { todayISO } from '@/components/expense/money-input';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { useAddOccurrence, useSkipOccurrence } from '@/lib/queries';
import { dueItems, ruleBlocker, scopeLabel, shortDate, type DueItem } from '@/lib/recurring';
import type { PendingOccurrence, SyncData } from '@/lib/types';

/**
 * Home's inbox of recurring bills that fell due: nothing is posted on its
 * own — each item is added (after a review, or straight from the template
 * via "Add all") or skipped by the person who set the bill up.
 */
export function DueToAddCard({ sync }: { sync: SyncData }) {
  const online = useOnline();
  const addOccurrence = useAddOccurrence();
  const skipOccurrence = useSkipOccurrence();
  const [reviewing, setReviewing] = useState<PendingOccurrence | undefined>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [addingAll, setAddingAll] = useState(false);

  const items = dueItems(sync);
  const today = todayISO();
  const ready = items.filter((i) => i.ready);

  const review = (occurrence: PendingOccurrence) => {
    setReviewing(occurrence);
    setReviewOpen(true);
  };

  const skip = (item: DueItem) => {
    skipOccurrence.mutate(item.occurrence.id, {
      onSuccess: () => toast(`Skipped ${item.occurrence.description}`),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  // One at a time, so a failure stops cleanly and says which bill it was.
  const addAll = async () => {
    setAddingAll(true);
    let added = 0;
    try {
      for (const item of ready) {
        await addOccurrence.mutateAsync({ occurrenceId: item.occurrence.id });
        added++;
      }
      toast(added === 1 ? '1 bill added' : `${added} bills added`);
    } catch (err) {
      const failed = ready[added]?.occurrence.description ?? 'A bill';
      toast.error(`${failed}: ${errorMessage(err)}`);
    } finally {
      setAddingAll(false);
    }
  };

  // The review sheet stays mounted when the inbox empties (its last item was
  // just added), so it can close normally.
  const form = (
    <ExpenseForm
      open={reviewOpen}
      onOpenChange={setReviewOpen}
      groupId={reviewing?.groupId ?? null}
      occurrence={reviewing}
    />
  );
  return (
    <>
      {items.length === 0 ? null : (
        <section className="flex flex-col gap-3" aria-labelledby="due-to-add-title">
          <div className="flex items-center justify-between gap-3">
            <span id="due-to-add-title" className="eyebrow">
              Due to add
            </span>
            {ready.length > 1 ? (
              <Button
                variant="outline"
                className="h-10 rounded-full px-4"
                disabled={!online || addingAll}
                onClick={() => void addAll()}
              >
                {addingAll ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Check data-icon="inline-start" aria-hidden="true" />
                )}
                {ready.length === items.length ? 'Add all' : `Add ${ready.length} ready`}
              </Button>
            ) : null}
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-[28px] bg-card">
            {items.map((item) => {
              const { occurrence } = item;
              const blocker = item.rule ? ruleBlocker(item.rule, sync) : 'This bill was deleted.';
              const overdue = occurrence.dueDate < today;
              return (
                <li key={occurrence.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
                      <CategoryIcon
                        category={item.rule?.template.category ?? 'general'}
                        className="size-5 text-foreground/70"
                      />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="truncate font-medium">
                        {occurrence.description}
                        <span className="text-muted-foreground"> · </span>
                        <span className="tabular-nums">
                          {formatMoney(occurrence.amountCents, occurrence.currency)}
                        </span>
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className={overdue ? 'font-medium text-owing' : undefined}>
                          due {shortDate(occurrence.dueDate, today)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{scopeLabel(occurrence, sync)}</span>
                      </p>
                      {blocker ? (
                        <p className="text-sm text-owing">{blocker} Skip it, or delete the bill.</p>
                      ) : !item.ready ? (
                        <p className="text-sm text-muted-foreground">
                          Someone in the split left — review before adding.
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex gap-2 pl-14">
                    <Button
                      className="h-10 rounded-full px-5"
                      disabled={!online || blocker !== null || addingAll}
                      onClick={() => review(occurrence)}
                    >
                      Add
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-10 rounded-full px-4 text-muted-foreground"
                      disabled={!online || addingAll}
                      onClick={() => skip(item)}
                    >
                      Skip
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <Link
            to="/recurring"
            className="flex items-center gap-1.5 self-start rounded-full px-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            <Repeat className="size-3.5" aria-hidden="true" />
            Manage recurring bills
          </Link>
        </section>
      )}
      {form}
    </>
  );
}
