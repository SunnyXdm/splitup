import { useEffect, useRef, useState } from 'react';
import { CalendarClock, ChevronRight, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import ExpenseForm from '@/components/expense/ExpenseForm';
import { todayISO } from '@/components/expense/money-input';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { orderByCurrency } from '@/lib/balances';
import { formatMoney } from '@/lib/money';
import { useAddOccurrence, useSkipOccurrence } from '@/lib/queries';
import { dueItems, ruleBlocker, scopeLabel, shortDate, type DueItem } from '@/lib/recurring';
import type { PendingOccurrence, SyncData } from '@/lib/types';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';
import { cn } from '@/lib/utils';

/** How long a Skip can be undone before it's sent. */
const SKIP_UNDO_MS = 5000;

const bills = (n: number) => (n === 1 ? '1 bill' : `${n} bills`);

/** "₹48,649.00" or "₹48,000.00 + $20.00" — per currency, never summed across. */
function totalLabel(items: DueItem[], primary: string): string {
  const byCurrency = new Map<string, number>();
  for (const { occurrence: o } of items) {
    byCurrency.set(o.currency, (byCurrency.get(o.currency) ?? 0) + o.amountCents);
  }
  return orderByCurrency(
    [...byCurrency].map(([currency, cents]) => ({ currency, cents })),
    primary,
  )
    .map((t) => formatMoney(t.cents, t.currency))
    .join(' + ');
}

/**
 * Recurring bills that fell due, as one compact row ("3 bills due · ₹48,649 ·
 * Review") that opens the list in a sheet. Nothing is posted on its own:
 * each bill is reviewed and added, recorded in bulk after a confirm list, or
 * skipped (with Undo) by the person who set it up.
 */
export function DueBillsRow({
  sync,
  showManageLink = true,
  className,
}: {
  sync: SyncData;
  /** "Manage recurring bills" inside the sheet (off on the Recurring screen). */
  showManageLink?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState<PendingOccurrence | undefined>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const skips = useDeferredSkips();

  const items = dueItems(sync).filter((i) => !skips.hidden.has(i.occurrence.id));
  const today = todayISO();
  const oldest = items[0]?.occurrence.dueDate;
  const overdue = oldest !== undefined && oldest < today;

  return (
    <>
      {items.length === 0 ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${bills(items.length)} due, ${totalLabel(items, sync.me.defaultCurrency)}. Review`}
          className={cn(
            'pressable flex min-h-16 w-full items-center gap-3 rounded-card bg-card p-3 pr-4 text-left outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-focus-ring',
            className,
          )}
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
            <CalendarClock className="size-5 text-foreground/70" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">{bills(items.length)} due</span>
            <span className="text-sm text-muted-foreground">
              <span className="tabular-nums">{totalLabel(items, sync.me.defaultCurrency)}</span>
              {oldest ? (
                <span className={overdue ? 'text-owing' : undefined}>
                  {' · '}
                  {items.length > 1 ? 'oldest ' : ''}due {shortDate(oldest, today)}
                </span>
              ) : null}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
            Review
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
        </button>
      )}
      <DueBillsSheet
        open={open}
        onOpenChange={setOpen}
        sync={sync}
        items={items}
        showManageLink={showManageLink}
        onReview={(o) => {
          setReviewing(o);
          setReviewOpen(true);
        }}
        onSkip={skips.skip}
      />
      {/* Stacked over the sheet; stays mounted when the list empties (its last
          bill was just added), so it can close normally. */}
      <ExpenseForm
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        groupId={reviewing?.groupId ?? null}
        occurrence={reviewing}
      />
    </>
  );
}

/**
 * Skip with Undo: the bill leaves the list at once, but the skip is only sent
 * after the toast's undo window. Leaving the screen sends pending skips now.
 */
function useDeferredSkips() {
  const skipOccurrence = useSkipOccurrence();
  const mutate = useRef(skipOccurrence.mutate);
  useEffect(() => {
    mutate.current = skipOccurrence.mutate;
  });
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const unhide = (id: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const commit = (id: number, description: string) => {
    timers.current.delete(id);
    mutate.current(id, {
      onError: (err) => {
        unhide(id);
        toast.error(`${description}: ${errorMessage(err)}`);
      },
    });
  };

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        mutate.current(id);
      }
      pending.clear();
    };
  }, []);

  const skip = (item: DueItem) => {
    const { id, description } = item.occurrence;
    setHidden((prev) => new Set(prev).add(id));
    timers.current.set(
      id,
      setTimeout(() => commit(id, description), SKIP_UNDO_MS),
    );
    toast(`Skipped ${description}`, {
      duration: SKIP_UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          const timer = timers.current.get(id);
          if (timer === undefined) return;
          clearTimeout(timer);
          timers.current.delete(id);
          unhide(id);
        },
      },
    });
  };

  return { hidden, skip };
}

function DueBillsSheet({
  open,
  onOpenChange,
  sync,
  items,
  showManageLink,
  onReview,
  onSkip,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sync: SyncData;
  items: DueItem[];
  showManageLink: boolean;
  onReview: (occurrence: PendingOccurrence) => void;
  onSkip: (item: DueItem) => void;
}) {
  const online = useOnline();
  const navigate = useOverlayNavigate();
  const addOccurrence = useAddOccurrence();
  const [confirming, setConfirming] = useState(false);
  const [recording, setRecording] = useState(false);
  const today = todayISO();
  const ready = items.filter((i) => i.ready);

  const handleOpenChange = (next: boolean) => {
    if (!next) setConfirming(false);
    onOpenChange(next);
  };

  // One at a time, so a failure stops cleanly and says which bill it was.
  const recordAll = async () => {
    const batch = ready;
    setRecording(true);
    let added = 0;
    try {
      for (const item of batch) {
        await addOccurrence.mutateAsync({ occurrenceId: item.occurrence.id });
        added++;
      }
      toast.success(`${bills(added)} recorded`);
      handleOpenChange(false);
    } catch (err) {
      const failed = batch[added]?.occurrence.description ?? 'A bill';
      toast.error(`${failed}: ${errorMessage(err)}`);
      setConfirming(false);
    } finally {
      setRecording(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-card"
      >
        <SheetHeader className="pr-14">
          <SheetTitle className="text-xl">
            {confirming ? `Record ${bills(ready.length)}?` : 'Bills due'}
          </SheetTitle>
          <SheetDescription>
            {confirming
              ? 'Each is added exactly as it was set up — same amount, payer and split.'
              : 'Recurring bills wait here until you add them. Nothing is recorded on its own.'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          {items.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">All caught up.</p>
          ) : confirming ? (
            <ul className="flex flex-col divide-y divide-border rounded-panel bg-muted/50">
              {ready.map(({ occurrence: o }) => (
                <li key={o.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium break-words">{o.description}</span>
                    <span className="text-sm text-muted-foreground">
                      {scopeLabel(o, sync)} · due {shortDate(o.dueDate, today)}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatMoney(o.amountCents, o.currency)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {items.map((item) => (
                <DueBillItem
                  key={item.occurrence.id}
                  item={item}
                  sync={sync}
                  today={today}
                  disabled={!online || recording}
                  onReview={() => onReview(item.occurrence)}
                  onSkip={() => onSkip(item)}
                />
              ))}
            </ul>
          )}
        </div>

        <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {confirming ? (
            <>
              <Button
                size="cta"
                className="w-full"
                disabled={!online || recording || ready.length === 0}
                onClick={() => void recordAll()}
              >
                {recording ? <Spinner data-icon="inline-start" /> : null}
                Record {bills(ready.length)}
              </Button>
              <Button
                variant="ghost"
                size="pill"
                className="w-full"
                disabled={recording}
                onClick={() => setConfirming(false)}
              >
                Back to the list
              </Button>
            </>
          ) : (
            <>
              {ready.length > 1 ? (
                <Button
                  size="cta"
                  className="w-full"
                  disabled={!online}
                  onClick={() => setConfirming(true)}
                >
                  Record {bills(ready.length)}
                  {ready.length < items.length ? ' that are ready' : ''}
                </Button>
              ) : null}
              {showManageLink ? (
                <Button
                  variant="ghost"
                  size="pill"
                  className="w-full text-muted-foreground"
                  onClick={() => {
                    navigate('/recurring');
                    handleOpenChange(false);
                  }}
                >
                  <Repeat data-icon="inline-start" aria-hidden="true" />
                  Manage recurring bills
                </Button>
              ) : null}
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DueBillItem({
  item,
  sync,
  today,
  disabled,
  onReview,
  onSkip,
}: {
  item: DueItem;
  sync: SyncData;
  today: string;
  disabled: boolean;
  onReview: () => void;
  onSkip: () => void;
}) {
  const { occurrence: o } = item;
  const blocker = item.rule ? ruleBlocker(item.rule, sync) : 'This bill was deleted.';
  const overdue = o.dueDate < today;
  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
          <CategoryIcon
            category={item.rule?.template.category ?? 'general'}
            className="size-5 text-foreground/70"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 font-medium break-words">{o.description}</p>
            <p className="shrink-0 font-medium tabular-nums">
              {formatMoney(o.amountCents, o.currency)}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className={overdue ? 'font-medium text-owing' : undefined}>
              Due {shortDate(o.dueDate, today)}
            </span>
            {' · '}
            {scopeLabel(o, sync)}
          </p>
          {blocker ? (
            <p className="text-sm text-warning">{blocker} Skip it, or delete the bill.</p>
          ) : !item.ready ? (
            <p className="text-sm text-muted-foreground">
              Someone in the split left — review before adding.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex gap-2 pl-14">
        <Button
          variant="outline"
          size="pill"
          disabled={disabled || blocker !== null}
          onClick={onReview}
        >
          Review
        </Button>
        <Button
          variant="ghost"
          size="pill"
          className="text-muted-foreground"
          disabled={disabled}
          onClick={onSkip}
        >
          Skip
        </Button>
      </div>
    </li>
  );
}
