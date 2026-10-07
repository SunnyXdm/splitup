import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
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
import { displayName, type NameCase } from '@/lib/names';
import { useDeleteExpense } from '@/lib/queries';
import { batchScopeHint, historyEntries, paymentRowAction } from '@/lib/settlement-batches';
import type { HistoryEntry } from '@/lib/settlement-batches';
import type { Expense, SettlementBatch, SyncData } from '@/lib/types';
import { EntranceScope } from '@/components/common/Entrance';
import { prefersReducedMotion, useEnterItem } from '@/lib/motion';
import { stableRowId, wasJustDeleted } from '@/lib/row-motion';
import { cn } from '@/lib/utils';

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

  const usersById = new Map(sync.users.map((u) => [u.id, u]));
  const groupsById = new Map(sync.groups.map((g) => [g.id, g.name]));
  // "You" as a sentence subject, "you" mid-sentence ("Priya paid you").
  const nameOf = (id: number, nameCase: NameCase = 'subject') =>
    displayName(usersById.get(id), meId, { case: nameCase });
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

  const { pathname } = useLocation();

  // Sorted newest first; settle-up rows fold into one entry when collapsing.
  // Rows I just deleted linger briefly (exiting) so they can collapse out.
  const entries = useExitingEntries(
    historyEntries(expenses, sync.settlementBatches, { collapse: collapseBatches }),
  );
  const months: { key: string; label: string; items: typeof entries }[] = [];
  for (const entry of entries) {
    const label = formatDateSafe(
      entry.kind === 'batch' ? entry.batch.date : entry.expense.date,
      'MMMM yyyy',
    );
    const last = months[months.length - 1];
    if (last && last.label === label) last.items.push(entry);
    // Keyed by month (not position), so a new month on top doesn't remount
    // — and replay the entrance of — every section below it.
    else {
      const seen = months.filter((m) => m.label === label).length;
      months.push({ key: `${label}-${seen}`, label, items: [entry] });
    }
  }

  const renderRow = (entry: HistoryEntry): ReactNode => {
    if (entry.kind === 'batch') {
      return (
        <BatchRow
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
          expense={e}
          nameOf={nameOf}
          tag={tagOf(e.groupId)}
          action={action}
          onTap={() => {
            const batch =
              e.settlementBatchId != null ? batchesById.get(e.settlementBatchId) : undefined;
            if (action === 'receipt' && batch) openReceipt(batch);
            else if (action === 'delete') setPaymentToDelete(e);
          }}
        />
      );
    }
    return (
      <ExpenseRow
        expense={e}
        meId={meId}
        nameOf={nameOf}
        tag={tagOf(e.groupId)}
        onSelect={onSelect}
      />
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <EntranceScope id={`history:${pathname}`}>
        {months.map(({ key, label, items }, sectionIndex) => (
          <MonthSection key={key} index={sectionIndex}>
            <h2 className="px-1 text-sm font-medium text-muted-foreground">{label}</h2>
            <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
              {items.map((entry) => {
                const row = renderRow(entry);
                if (entry.exiting) {
                  return (
                    <div key={entry.motionKey} className="motion-row-exit" aria-hidden="true">
                      <div>{row}</div>
                    </div>
                  );
                }
                return (
                  <RowMotion key={entry.motionKey} entry={entry}>
                    {row}
                  </RowMotion>
                );
              })}
            </div>
          </MonthSection>
        ))}
      </EntranceScope>

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
                    'object',
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

/** One month of history; months stagger in on the screen's first visit. */
function MonthSection({ index, children }: { index: number; children: ReactNode }) {
  const enter = useEnterItem(index);
  return (
    <section className={cn('flex flex-col gap-2', enter.className)} style={enter.style}>
      {children}
    </section>
  );
}

type MotionEntry = HistoryEntry & { motionKey: string; exiting?: boolean };

/** Rows keep one key from optimistic add through server confirmation. */
function motionKeyOf(entry: HistoryEntry): string {
  return entry.kind === 'expense' ? `e${stableRowId(entry.expense.id)}` : entry.key;
}

const EXIT_MS = 380;

/**
 * The entries plus, for a moment, any row I just deleted (flagged `exiting`,
 * kept where it was) so it can collapse out instead of vanishing. Only
 * deletions recorded by useDeleteExpense qualify — filtering, refetches and
 * other people's changes never animate rows out.
 */
function useExitingEntries(entries: HistoryEntry[]): MotionEntry[] {
  const current: MotionEntry[] = entries.map((e) => ({ ...e, motionKey: motionKeyOf(e) }));
  const sig = current.map((e) => e.motionKey).join(',');
  const [snap, setSnap] = useState({ sig, entries: current });
  const [ghosts, setGhosts] = useState<{ entry: MotionEntry; before: string | null }[]>([]);

  if (snap.sig !== sig) {
    // Adjusting state during render (React's "previous props" pattern).
    const keys = new Set(current.map((e) => e.motionKey));
    const gone = snap.entries
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e }) =>
          !keys.has(e.motionKey) &&
          !e.exiting &&
          e.kind === 'expense' &&
          wasJustDeleted(e.expense.id),
      );
    if (gone.length > 0 && !prefersReducedMotion()) {
      const added = gone.map(({ e, i }) => ({
        entry: { ...e, exiting: true },
        before: snap.entries.slice(i + 1).find((n) => keys.has(n.motionKey))?.motionKey ?? null,
      }));
      setGhosts((g) => [...g, ...added]);
    }
    setSnap({ sig, entries: current });
  }

  useEffect(() => {
    if (ghosts.length === 0) return;
    const done = new Set(ghosts.map((g) => g.entry.motionKey));
    const timer = setTimeout(
      () => setGhosts((g) => g.filter((x) => !done.has(x.entry.motionKey))),
      EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [ghosts]);

  if (ghosts.length === 0) return current;
  const merged = [...current];
  const present = new Set(current.map((e) => e.motionKey));
  for (const { entry, before } of ghosts) {
    if (present.has(entry.motionKey)) continue; // restored (delete failed)
    const at = before === null ? -1 : merged.findIndex((e) => e.motionKey === before);
    if (at === -1) merged.push(entry);
    else merged.splice(at, 0, entry);
  }
  return merged;
}

/**
 * Row wrapper: an optimistic row (temp negative id) that mounts slides in
 * with a brief highlight — once; it keeps its key when the server row
 * replaces it, so confirmation doesn't replay anything.
 */
function RowMotion({ entry, children }: { entry: HistoryEntry; children: ReactNode }) {
  const [fresh] = useState(
    () => (entry.kind === 'expense' ? entry.expense.id : entry.batch.id) < 0,
  );
  return <div className={fresh ? 'motion-row-new' : undefined}>{children}</div>;
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
  nameOf: (id: number, nameCase?: NameCase) => string;
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
      className="flex min-h-16 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
  nameOf: (id: number, nameCase?: NameCase) => string;
  tag?: string;
  onOpen: () => void;
}) {
  const payer = nameOf(batch.payerId);
  const payee = nameOf(batch.payeeId, 'object');
  const line = `${payer} paid ${payee}`;
  const hint = batchScopeHint(rows);
  const amount = formatMoney(batch.amountCents, batch.currency);
  return (
    <button
      type="button"
      disabled={batch.id < 0}
      onClick={onOpen}
      className="flex min-h-14 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
  nameOf: (id: number, nameCase?: NameCase) => string;
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
      className="flex min-h-14 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      aria-label={`Payment: ${payer ? nameOf(payer.userId) : 'Someone'} paid ${
        recipient ? nameOf(recipient.userId, 'object') : 'someone'
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
          {recipient ? nameOf(recipient.userId, 'object') : 'someone'}
        </span>
        {tag ? <Tag tag={tag} /> : null}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {formatMoney(e.amountCents, e.currency)}
      </span>
    </button>
  );
}
