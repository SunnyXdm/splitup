import { useState } from 'react';
import { HandCoins } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { MoneyText } from '@/components/common/MoneyText';
import SettlementReceipt from '@/components/expense/SettlementReceipt';
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
import { formatDateSafe } from '@/lib/dates';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { useDeleteExpense } from '@/lib/queries';
import { batchScopeHint, historyEntries, paymentRowAction } from '@/lib/settlement-batches';
import type { Expense, SettlementBatch, SyncData } from '@/lib/types';

interface ExpenseHistoryProps {
  sync: SyncData;
  /** Already-filtered expenses; the component sorts and groups them by month. */
  expenses: Expense[];
  /**
   * Row tap on a regular expense. Payments of a settle-up open its receipt
   * (inert if the batch isn't synced yet); legacy payments (no batch) open a
   * delete confirmation.
   */
  onSelect?: (expense: Expense) => void;
  /** Tag each row with its group name (or "Direct") — used on FriendDetail. */
  showGroupTag?: boolean;
  /** Fold every row of one settle-up into a single entry — used on FriendDetail. */
  collapseBatches?: boolean;
}

/** Month-grouped expense list shared by GroupDetail and FriendDetail. */
export default function ExpenseHistory({
  sync,
  expenses,
  onSelect,
  showGroupTag = false,
  collapseBatches = false,
}: ExpenseHistoryProps) {
  const meId = sync.me.id;
  const online = useOnline();
  const deleteExpense = useDeleteExpense();
  const [paymentToDelete, setPaymentToDelete] = useState<Expense | null>(null);
  // Kept after close so the receipt doesn't blank out mid-animation.
  const [receipt, setReceipt] = useState<SettlementBatch | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const batchesById = new Map((sync.settlementBatches ?? []).map((b) => [b.id, b]));
  const openReceipt = (batch: SettlementBatch) => {
    setReceipt(batch);
    setReceiptOpen(true);
  };

  const usersById = new Map(sync.users.map((u) => [u.id, u.name]));
  const groupsById = new Map(sync.groups.map((g) => [g.id, g.name]));
  const nameOf = (id: number) => (id === meId ? 'You' : (usersById.get(id) ?? 'Someone'));
  const tagOf = (groupId: number | null) =>
    showGroupTag ? (groupId === null ? 'Direct' : (groupsById.get(groupId) ?? 'Group')) : undefined;

  const confirmDeletePayment = () => {
    if (!paymentToDelete) return;
    deleteExpense.mutate(paymentToDelete.id, {
      onSuccess: () => toast('Payment deleted'),
      onError: (err) => toast.error(errorMessage(err)),
      onSettled: () => setPaymentToDelete(null),
    });
  };

  // Sorted newest first; settle-up rows fold into one entry when collapsing.
  const entries = historyEntries(expenses, sync.settlementBatches, {
    collapse: collapseBatches,
  });
  const months: { label: string; items: typeof entries }[] = [];
  for (const entry of entries) {
    const label = formatDateSafe(
      entry.kind === 'batch' ? entry.batch.date : entry.expense.date,
      'MMMM yyyy',
    );
    const last = months[months.length - 1];
    if (last && last.label === label) last.items.push(entry);
    else months.push({ label, items: [entry] });
  }

  return (
    <div className="flex flex-col gap-6">
      {months.map(({ label, items }, sectionIndex) => (
        <section
          key={`${label}-${sectionIndex}`}
          className="flex animate-in flex-col gap-2 duration-300 fill-mode-backwards fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
          style={{ animationDelay: `${Math.min(sectionIndex, 6) * 60}ms` }}
        >
          <h2 className="px-1 text-sm font-medium text-muted-foreground">{label}</h2>
          <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
            {items.map((entry) => {
              if (entry.kind === 'batch') {
                return (
                  <BatchRow
                    key={entry.key}
                    batch={entry.batch}
                    rows={entry.rows}
                    nameOf={nameOf}
                    tag={entry.rows.length === 1 ? tagOf(entry.rows[0].groupId) : undefined}
                    onOpen={() => openReceipt(entry.batch)}
                  />
                );
              }
              const e = entry.expense;
              if (e.isPayment) {
                const action = paymentRowAction(e, batchesById);
                return (
                  <PaymentRow
                    key={entry.key}
                    expense={e}
                    nameOf={nameOf}
                    tag={tagOf(e.groupId)}
                    action={action}
                    onTap={() => {
                      const batch =
                        e.settlementBatchId != null
                          ? batchesById.get(e.settlementBatchId)
                          : undefined;
                      if (action === 'receipt' && batch) openReceipt(batch);
                      else if (action === 'delete') setPaymentToDelete(e);
                    }}
                  />
                );
              }
              return (
                <ExpenseRow
                  key={entry.key}
                  expense={e}
                  meId={meId}
                  nameOf={nameOf}
                  tag={tagOf(e.groupId)}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        </section>
      ))}

      <SettlementReceipt open={receiptOpen} onOpenChange={setReceiptOpen} batch={receipt} />

      <AlertDialog
        open={paymentToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPaymentToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this payment?</AlertDialogTitle>
            <AlertDialogDescription>
              {paymentToDelete
                ? `${nameOf(
                    paymentToDelete.shares.find((s) => s.paidCents > 0)?.userId ?? 0,
                  )} paid ${nameOf(
                    paymentToDelete.shares.find((s) => s.owedCents > 0)?.userId ?? 0,
                  )} ${formatMoney(paymentToDelete.amountCents, paymentToDelete.currency)}. Deleting it restores the balance it settled.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteExpense.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!online || deleteExpense.isPending}
              onClick={confirmDeletePayment}
            >
              Delete payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Tag({ tag }: { tag: string }) {
  return (
    <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
      {tag}
    </span>
  );
}

function ExpenseRow({
  expense: e,
  meId,
  nameOf,
  tag,
  onSelect,
}: {
  expense: Expense;
  meId: number;
  nameOf: (id: number) => string;
  tag?: string;
  onSelect?: (expense: Expense) => void;
}) {
  const payers = e.shares.filter((s) => s.paidCents > 0);
  const paidLine =
    payers.length === 1
      ? `${nameOf(payers[0].userId)} paid ${formatMoney(e.amountCents, e.currency)}`
      : `${payers.length} people paid ${formatMoney(e.amountCents, e.currency)}`;
  const mine = e.shares.find((s) => s.userId === meId);
  const net = mine ? mine.paidCents - mine.owedCents : 0;
  // Negative id = optimistic row still being saved — not editable yet.
  const clickable = onSelect !== undefined && e.id > 0;
  return (
    <button
      type="button"
      onClick={clickable ? () => onSelect(e) : undefined}
      disabled={!clickable}
      className="flex min-h-16 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background">
        <CategoryIcon category={e.category} className="size-4 text-foreground/70" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{e.description}</span>
          {tag ? <Tag tag={tag} /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {formatDateSafe(e.date, 'MMM d', '—')} · {paidLine}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {net === 0 ? (
          <span className="text-xs text-muted-foreground">not involved</span>
        ) : (
          <>
            <span className="text-[11px] text-muted-foreground">
              {net > 0 ? 'you lent' : 'you borrowed'}
            </span>
            <MoneyText signed cents={net} currency={e.currency} className="text-sm font-medium" />
          </>
        )}
      </span>
    </button>
  );
}

/** One settle-up, collapsed: the cash that moved, however many rows it was recorded as. */
function BatchRow({
  batch,
  rows,
  nameOf,
  tag,
  onOpen,
}: {
  batch: SettlementBatch;
  rows: Expense[];
  nameOf: (id: number) => string;
  tag?: string;
  onOpen: () => void;
}) {
  const payer = nameOf(batch.payerId);
  const payee = nameOf(batch.payeeId);
  const line = `${payer} paid ${payee === 'You' ? 'you' : payee}`;
  const hint = batchScopeHint(rows);
  const amount = formatMoney(batch.amountCents, batch.currency);
  return (
    <button
      type="button"
      disabled={batch.id < 0}
      onClick={onOpen}
      className="flex min-h-14 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Payment: ${line} ${amount}${hint ? `, ${hint.toLowerCase()}` : ''}. Tap for the receipt.`}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <HandCoins className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate">{line}</span>
          {tag ? <Tag tag={tag} /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {formatDateSafe(batch.date, 'MMM d', '—')}
          {hint ? ` · ${hint}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-sm tabular-nums">{amount}</span>
    </button>
  );
}

function PaymentRow({
  expense: e,
  nameOf,
  tag,
  action,
  onTap,
}: {
  expense: Expense;
  nameOf: (id: number) => string;
  tag?: string;
  action: 'receipt' | 'delete' | 'none';
  onTap: () => void;
}) {
  const payer = e.shares.find((s) => s.paidCents > 0);
  const recipient = e.shares.find((s) => s.owedCents > 0);
  return (
    <button
      type="button"
      disabled={e.id < 0 || action === 'none'}
      onClick={onTap}
      className="flex min-h-14 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Payment: ${payer ? nameOf(payer.userId) : 'Someone'} paid ${
        recipient ? nameOf(recipient.userId) : 'someone'
      } ${formatMoney(e.amountCents, e.currency)}.${
        action === 'receipt'
          ? ' Tap for the receipt.'
          : action === 'delete'
            ? ' Tap to delete.'
            : ''
      }`}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
        <HandCoins className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <span className="truncate">
          {payer ? nameOf(payer.userId) : 'Someone'} paid{' '}
          {recipient ? nameOf(recipient.userId) : 'someone'}
        </span>
        {tag ? <Tag tag={tag} /> : null}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {formatMoney(e.amountCents, e.currency)}
      </span>
    </button>
  );
}
