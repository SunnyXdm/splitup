import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { HandCoins } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
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
import { formatMoney } from '@/lib/money';
import { useDeleteExpense } from '@/lib/queries';
import type { Expense, SyncData } from '@/lib/types';

interface ExpenseHistoryProps {
  sync: SyncData;
  /** Already-filtered expenses; the component sorts and groups them by month. */
  expenses: Expense[];
  /** Row tap on a regular expense (payments open a delete confirmation instead). */
  onSelect?: (expense: Expense) => void;
  /** Tag each row with its group name (or "Direct") — used on FriendDetail. */
  showGroupTag?: boolean;
}

/** Month-grouped expense list shared by GroupDetail and FriendDetail. */
export default function ExpenseHistory({
  sync,
  expenses,
  onSelect,
  showGroupTag = false,
}: ExpenseHistoryProps) {
  const meId = sync.me.id;
  const online = useOnline();
  const deleteExpense = useDeleteExpense();
  const [paymentToDelete, setPaymentToDelete] = useState<Expense | null>(null);

  const usersById = new Map(sync.users.map((u) => [u.id, u.name]));
  const groupsById = new Map(sync.groups.map((g) => [g.id, g.name]));
  const nameOf = (id: number) => (id === meId ? 'You' : (usersById.get(id) ?? 'Someone'));
  const tagOf = (groupId: number | null) =>
    showGroupTag ? (groupId === null ? 'Direct' : (groupsById.get(groupId) ?? 'Group')) : undefined;

  const confirmDeletePayment = () => {
    if (!paymentToDelete) return;
    deleteExpense.mutate(paymentToDelete.id, {
      onSuccess: () => toast('Payment deleted'),
      onError: (err) => toast.error(err.message),
      onSettled: () => setPaymentToDelete(null),
    });
  };

  const sorted = [...expenses].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
  );
  const months: { label: string; items: Expense[] }[] = [];
  for (const e of sorted) {
    const label = format(parseISO(e.date), 'MMMM yyyy');
    const last = months[months.length - 1];
    if (last && last.label === label) last.items.push(e);
    else months.push({ label, items: [e] });
  }

  return (
    <div className="flex flex-col gap-6">
      {months.map(({ label, items }, sectionIndex) => (
        <section
          key={label}
          className="flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 motion-reduce:animate-none"
          style={{ animationDelay: `${Math.min(sectionIndex, 6) * 60}ms` }}
        >
          <h2 className="px-1 text-sm font-medium text-muted-foreground">{label}</h2>
          <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
            {items.map((e) =>
              e.isPayment ? (
                <PaymentRow
                  key={e.id}
                  expense={e}
                  nameOf={nameOf}
                  tag={tagOf(e.groupId)}
                  onDelete={() => setPaymentToDelete(e)}
                />
              ) : (
                <ExpenseRow
                  key={e.id}
                  expense={e}
                  meId={meId}
                  nameOf={nameOf}
                  tag={tagOf(e.groupId)}
                  onSelect={onSelect}
                />
              ),
            )}
          </div>
        </section>
      ))}

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
          {format(parseISO(e.date), 'MMM d')} · {paidLine}
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

function PaymentRow({
  expense: e,
  nameOf,
  tag,
  onDelete,
}: {
  expense: Expense;
  nameOf: (id: number) => string;
  tag?: string;
  onDelete: () => void;
}) {
  const payer = e.shares.find((s) => s.paidCents > 0);
  const recipient = e.shares.find((s) => s.owedCents > 0);
  return (
    <button
      type="button"
      disabled={e.id < 0}
      onClick={onDelete}
      className="flex min-h-14 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={`Payment: ${payer ? nameOf(payer.userId) : 'Someone'} paid ${
        recipient ? nameOf(recipient.userId) : 'someone'
      } ${formatMoney(e.amountCents, e.currency)}. Tap to delete.`}
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
      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
        {formatMoney(e.amountCents, e.currency)}
      </span>
    </button>
  );
}
