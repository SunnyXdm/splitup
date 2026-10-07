import { useState } from 'react';
import { HandCoins, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { MoneyText } from '@/components/common/MoneyText';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { errorMessage } from '@/lib/api';
import { formatDateSafe } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { useSyncData, useUndoSettlement } from '@/lib/queries';
import { batchScopeHint, isBatchParticipant, methodLabel } from '@/lib/settlement-batches';
import type { SettlementBatch, SyncData } from '@/lib/types';

export interface SettlementReceiptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept by the caller after close so the sheet doesn't empty mid-animation. */
  batch: SettlementBatch | null;
}

/** One settle-up as a receipt: the cash that moved, its details, and where it was recorded. */
export default function SettlementReceipt({ open, onOpenChange, batch }: SettlementReceiptProps) {
  const { data: sync } = useSyncData();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl rounded-t-[28px]"
      >
        {batch && sync ? (
          <ReceiptBody batch={batch} sync={sync} onClose={() => onOpenChange(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ReceiptBody({
  batch,
  sync,
  onClose,
}: {
  batch: SettlementBatch;
  sync: SyncData;
  onClose: () => void;
}) {
  const online = useOnline();
  const undo = useUndoSettlement();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const meId = sync.me.id;
  const nameOf = (id: number) =>
    id === meId ? 'You' : (sync.users.find((u) => u.id === id)?.name ?? 'Someone');
  const rows = sync.expenses
    .filter((e) => e.settlementBatchId === batch.id)
    .sort((a, b) => a.id - b.id);
  const headline =
    batch.payerId === meId
      ? `You paid ${nameOf(batch.payeeId)}`
      : batch.payeeId === meId
        ? `${nameOf(batch.payerId)} paid you`
        : `${nameOf(batch.payerId)} paid ${nameOf(batch.payeeId)}`;
  const hint = batchScopeHint(rows);
  const pending = batch.id < 0 || rows.some((r) => r.id < 0);
  // Co-members see settle-ups recorded in their groups, read-only: only the
  // two people the cash moved between (or whoever recorded it) may undo.
  const canUndo = isBatchParticipant(batch, meId);
  const details = [
    { label: 'Method', value: methodLabel(batch.method) },
    { label: 'Reference', value: batch.reference },
    { label: 'Note', value: batch.note },
    { label: 'Recorded by', value: nameOf(batch.createdBy) },
  ].filter((d): d is { label: string; value: string } => Boolean(d.value));

  const confirmUndo = () => {
    undo.mutate(batch.id, {
      onSuccess: () => toast('Payment undone'),
      onError: (err) => toast.error(errorMessage(err)),
    });
    // Optimistic: the receipt's rows are already gone from every list.
    setConfirmOpen(false);
    onClose();
  };

  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="text-xl">Payment</SheetTitle>
        <SheetDescription>{formatDateSafe(batch.date, 'EEEE, MMMM d, yyyy', '—')}</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-2">
        <div className="flex flex-col items-center gap-2 rounded-[28px] bg-muted/50 px-4 py-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-background text-muted-foreground">
            <HandCoins className="size-5" aria-hidden="true" />
          </span>
          <MoneyText
            cents={batch.amountCents}
            currency={batch.currency}
            className="text-4xl font-medium tracking-tight"
          />
          <p className="text-base">{headline}</p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>

        {details.length > 0 ? (
          <dl className="flex flex-col divide-y divide-border/60 rounded-[20px] bg-card px-4">
            {details.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-4 py-3 text-sm">
                <dt className="shrink-0 text-muted-foreground">{d.label}</dt>
                <dd className="min-w-0 text-right break-words whitespace-pre-wrap">{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Recorded as</span>
            <div className="flex flex-col gap-1 rounded-[20px] bg-muted/50 px-4 py-3">
              {rows.map((r) => {
                const payer = r.shares.find((s) => s.paidCents > 0)?.userId ?? 0;
                const recipient = r.shares.find((s) => s.owedCents > 0)?.userId ?? 0;
                const group =
                  r.groupId !== null ? sync.groups.find((g) => g.id === r.groupId) : null;
                const scopeLabel = group
                  ? `${group.emoji} ${group.name}`
                  : r.groupId !== null
                    ? 'Group'
                    : 'Direct';
                // A row against the cash direction is an offsetting entry.
                const counter = payer !== batch.payerId;
                return (
                  <div
                    key={r.id}
                    className={`flex items-baseline justify-between gap-3 text-sm ${
                      counter ? 'text-muted-foreground' : ''
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      {scopeLabel}
                      <span className="text-muted-foreground">
                        {' '}
                        · {nameOf(payer)} → {nameOf(recipient)}
                      </span>
                      {counter ? <span className="text-muted-foreground"> (offsets)</span> : null}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      {formatMoney(r.amountCents, r.currency)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {canUndo ? (
          <Button
            variant="outline"
            className="h-12 w-full rounded-full text-destructive hover:text-destructive"
            disabled={!online || pending}
            onClick={() => setConfirmOpen(true)}
          >
            <Undo2 data-icon="inline-start" aria-hidden="true" />
            Undo payment
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            Only {nameOf(batch.payerId)} or {nameOf(batch.payeeId)} can undo this payment.
          </p>
        )}
        {canUndo && !online ? (
          <p className="text-center text-xs text-muted-foreground">
            You&rsquo;re offline — viewing only.
          </p>
        ) : null}
      </SheetFooter>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${headline} ${formatMoney(batch.amountCents, batch.currency)}. Undoing removes it${
                rows.length > 1 ? ` and all ${rows.length} entries it was recorded as` : ''
              }, so the balances go back to what they were before.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!online} onClick={confirmUndo}>
              Undo payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
