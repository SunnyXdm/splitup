import { useState } from 'react';
import { useLocation } from 'react-router';
import {
  ChevronRight,
  EllipsisVertical,
  HandCoins,
  History,
  PencilLine,
  Repeat2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { MoneyText } from '@/components/common/MoneyText';
import { GuestPill, UserAvatar } from '@/components/common/UserAvatar';
import ExpenseHistorySheet from '@/components/expense/ExpenseHistorySheet';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { CATEGORY_META } from '@/lib/categories';
import { formatDateSafe } from '@/lib/dates';
import { isGuest } from '@/lib/guests';
import { myStake } from '@/lib/history-rows';
import { formatMoney } from '@/lib/money';
import { curlyQuotes, displayName } from '@/lib/names';
import { useDeleteExpense, useSyncData } from '@/lib/queries';
import type { Expense, SyncData, User } from '@/lib/types';
import type { ExpenseDetailState } from '@/lib/use-expense-detail';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';
import { cn } from '@/lib/utils';

interface DetailActions {
  /** Opens the screen's ExpenseForm in edit mode (the same path a row tap used to take). */
  onEdit?: (expense: Expense) => void;
  /** Opens the screen's ExpenseForm as a copy dated today. Omitted = no Repeat action. */
  onRepeat?: (expense: Expense) => void;
}

/**
 * The detail sheet plus the settlement receipt for one screen, driven by
 * useExpenseDetail(): <ExpenseDetailSheets detail={detail} onEdit={…} />.
 */
export function ExpenseDetailSheets({
  detail,
  onEdit,
  onRepeat,
}: DetailActions & { detail: ExpenseDetailState }) {
  return (
    <>
      <ExpenseDetailSheet
        open={detail.detailOpen}
        onOpenChange={detail.setDetailOpen}
        expense={detail.expense}
        onEdit={onEdit}
        onRepeat={onRepeat}
      />
      <SettlementReceipt
        open={detail.receiptOpen}
        onOpenChange={detail.setReceiptOpen}
        batch={detail.batch}
      />
    </>
  );
}

/**
 * Read-only view of one expense (ASTRA #6): full title, where it belongs, the
 * bill, who paid, everyone's share and what it did to you — then Edit. History,
 * Repeat and Delete sit in the ⋯ menu, away from the thumb zone.
 */
export default function ExpenseDetailSheet({
  open,
  onOpenChange,
  expense,
  onEdit,
  onRepeat,
}: DetailActions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept by the caller after close so the sheet doesn't empty mid-animation. */
  expense: Expense | null;
}) {
  const { data: sync } = useSyncData();
  // Always show the latest saved version (an edit elsewhere updates it live).
  const current = expense ? (sync?.expenses.find((e) => e.id === expense.id) ?? expense) : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-[28px]"
      >
        {current && sync ? (
          <DetailBody
            expense={current}
            sync={sync}
            deleted={!sync.expenses.some((e) => e.id === current.id)}
            onClose={() => onOpenChange(false)}
            onEdit={onEdit}
            onRepeat={onRepeat}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface Line {
  user: User | undefined;
  userId: number;
  cents: number;
}

function DetailBody({
  expense: e,
  sync,
  deleted,
  onClose,
  onEdit,
  onRepeat,
}: DetailActions & {
  expense: Expense;
  sync: SyncData;
  deleted: boolean;
  onClose: () => void;
}) {
  const online = useOnline();
  const navigate = useOverlayNavigate();
  const { pathname } = useLocation();
  const deleteExpense = useDeleteExpense();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const meId = sync.me.id;
  const usersById = new Map(sync.users.map((u) => [u.id, u]));
  const subject = (id: number) => displayName(usersById.get(id), meId);
  const object = (id: number) => displayName(usersById.get(id), meId, { case: 'object' });
  const money = (cents: number) => formatMoney(cents, e.currency);
  // Me first, then by name: you look for yourself before anyone else.
  const order = (a: Line, b: Line) =>
    a.userId === meId
      ? -1
      : b.userId === meId
        ? 1
        : subject(a.userId).localeCompare(subject(b.userId));
  const payers: Line[] = e.shares
    .filter((s) => s.paidCents > 0)
    .map((s) => ({ user: usersById.get(s.userId), userId: s.userId, cents: s.paidCents }))
    .sort(order);
  const owers: Line[] = e.shares
    .filter((s) => s.owedCents > 0)
    .map((s) => ({ user: usersById.get(s.userId), userId: s.userId, cents: s.owedCents }))
    .sort(order);

  const group = e.groupId !== null ? sync.groups.find((g) => g.id === e.groupId) : undefined;
  const otherId = e.groupId === null ? e.shares.find((s) => s.userId !== meId)?.userId : undefined;
  const scopePath = group
    ? `/groups/${group.id}`
    : otherId !== undefined && sync.friendIds.includes(otherId)
      ? `/friends/${otherId}`
      : null;
  const scopeLabel = group
    ? `In ${group.emoji} ${group.name}`
    : e.groupId !== null
      ? 'In a group you’ve left'
      : otherId !== undefined
        ? `Direct with ${subject(otherId)}`
        : 'Just you';

  const stake = myStake(e, meId);
  const where = group
    ? ` in ${group.name}`
    : otherId !== undefined
      ? ` with ${object(otherId)}`
      : '';
  let effect: string;
  if (e.isPayment) {
    effect = '';
  } else if (!stake.involved) {
    effect = 'You’re not part of this expense.';
  } else if (stake.netCents > 0) {
    effect = `You lent ${money(stake.netCents)}${where}.`;
  } else if (stake.netCents < 0) {
    effect = `You borrowed ${money(-stake.netCents)}${where}.`;
  } else {
    effect = 'No balance change — you paid exactly your share.';
  }

  const pending = e.id < 0;
  const canRepeat = onRepeat !== undefined && !e.isPayment && !deleted;
  const canEdit = onEdit !== undefined && !e.isPayment && !deleted;
  const added = formatDateSafe(e.createdAt, 'MMM d, yyyy', '');

  const confirmDelete = () => {
    deleteExpense.mutate(e.id, {
      onSuccess: () => {
        toast(e.isPayment ? 'Payment deleted' : 'Expense deleted');
        setConfirmOpen(false);
        onClose();
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const paymentLine =
    payers[0] && owers[0] ? `${subject(payers[0].userId)} paid ${object(owers[0].userId)}` : null;

  return (
    <>
      <SheetHeader className="flex-row items-start gap-3 pr-24 pb-2">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
          {e.isPayment ? (
            <HandCoins className="size-5 text-foreground/70" aria-hidden="true" />
          ) : (
            <CategoryIcon category={e.category} className="size-5 text-foreground/70" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <SheetTitle className="text-xl leading-snug break-words">
            {e.isPayment ? 'Payment' : curlyQuotes(e.description)}
          </SheetTitle>
          <SheetDescription>
            {formatDateSafe(e.date, 'EEE, MMM d, yyyy', '—')}
            {e.isPayment ? null : ` · ${CATEGORY_META[e.category]?.label ?? 'General'}`}
          </SheetDescription>
        </div>
      </SheetHeader>
      {deleted ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 right-13 size-10 rounded-full"
                disabled={pending}
              />
            }
          >
            <EllipsisVertical aria-hidden="true" />
            <span className="sr-only">More actions</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
              <History aria-hidden="true" /> History
            </DropdownMenuItem>
            {canRepeat ? (
              <DropdownMenuItem
                onClick={() => {
                  onClose();
                  onRepeat(e);
                }}
              >
                <Repeat2 aria-hidden="true" /> Repeat today
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!online}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 aria-hidden="true" /> {e.isPayment ? 'Delete payment' : 'Delete expense'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-2">
        <div className="flex flex-col gap-3 rounded-card bg-muted/50 px-5 py-5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-muted-foreground">
              {e.isPayment ? (paymentLine ?? 'Payment') : 'Bill total'}
            </span>
            <MoneyText
              cents={e.amountCents}
              currency={e.currency}
              className="text-3xl font-medium tracking-tight"
            />
          </div>
          {scopePath && scopePath !== pathname ? (
            <button
              type="button"
              onClick={() => {
                navigate(scopePath);
                onClose();
              }}
              className="relative -mx-2 flex min-h-11 w-fit max-w-full items-center gap-1 rounded-full px-2 text-left text-sm font-medium outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <span className="min-w-0 break-words">{scopeLabel}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : (
            <span className="text-sm font-medium break-words">{scopeLabel}</span>
          )}
          {deleted ? (
            <p className="text-sm text-destructive">This expense has been deleted.</p>
          ) : null}
        </div>

        {e.isPayment ? null : (
          <section className="flex flex-col gap-2" aria-label="Your part">
            <div className="flex flex-col gap-1 rounded-panel bg-card px-4 py-3">
              <p className="text-base font-medium">{effect}</p>
              {stake.involved ? (
                <p className="text-sm text-muted-foreground">
                  Your share {money(stake.shareCents)} · you paid {money(stake.paidCents)}
                </p>
              ) : null}
            </div>
          </section>
        )}

        {e.isPayment ? null : (
          <>
            <PeopleList
              title={payers.length === 1 ? 'Paid by' : `Paid by ${payers.length} people`}
              lines={payers}
              meId={meId}
              subject={subject}
              money={money}
            />
            <PeopleList
              title={`Split between ${owers.length} ${owers.length === 1 ? 'person' : 'people'}`}
              lines={owers}
              meId={meId}
              subject={subject}
              money={money}
            />
          </>
        )}

        {e.notes ? (
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-sm font-medium text-muted-foreground">Notes</h3>
            <p className="rounded-panel bg-card px-4 py-3 text-sm break-words whitespace-pre-wrap">
              {e.notes}
            </p>
          </section>
        ) : null}

        <p className="px-1 text-xs text-muted-foreground">
          Added by {object(e.createdBy)}
          {added ? ` on ${added}` : ''}
        </p>
      </div>

      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {canEdit ? (
          <Button
            size="cta"
            className="w-full"
            disabled={pending}
            onClick={() => {
              onClose();
              onEdit(e);
            }}
          >
            <PencilLine data-icon="inline-start" aria-hidden="true" />
            Edit expense
          </Button>
        ) : (
          <Button size="cta" className="w-full" onClick={onClose}>
            Done
          </Button>
        )}
        {pending ? (
          <p className="text-center text-xs text-muted-foreground">Saving — one moment.</p>
        ) : null}
      </SheetFooter>

      <ExpenseHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        expense={e}
        // The detail shows the pre-restore version until sync lands; close it.
        onRestored={onClose}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {e.isPayment ? 'Delete this payment?' : 'Delete this expense?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {e.isPayment
                ? `${paymentLine ?? 'This payment'} ${money(e.amountCents)}. Deleting it restores the balance it settled.`
                : `“${e.description}” will be removed and everyone’s balances will update. You can restore it from Recently deleted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteExpense.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!online || deleteExpense.isPending}
              onClick={confirmDelete}
            >
              {deleteExpense.isPending ? <Spinner data-icon="inline-start" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PeopleList({
  title,
  lines,
  meId,
  subject,
  money,
}: {
  title: string;
  lines: Line[];
  meId: number;
  subject: (id: number) => string;
  money: (cents: number) => string;
}) {
  if (lines.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col divide-y divide-border/60 rounded-panel bg-card px-4">
        {lines.map((l) => (
          <li key={l.userId} className="flex min-h-12 items-center gap-3 py-2">
            <UserAvatar user={l.user} size="sm" />
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn('text-sm break-words', l.userId === meId && 'font-medium')}>
                {subject(l.userId)}
              </span>
              {isGuest(l.user) ? <GuestPill /> : null}
            </span>
            <span className="shrink-0 text-sm tabular-nums">{money(l.cents)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
