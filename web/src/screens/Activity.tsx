import { useState, type ReactNode } from 'react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { parseDateSafe } from '@/lib/dates';
import {
  ArchiveRestore,
  CalendarClock,
  ChevronDown,
  HandCoins,
  HeartHandshake,
  PencilLine,
  ReceiptText,
  Sparkles,
  Trash2,
  Undo2,
  UserRoundCheck,
  UserRoundMinus,
  UserRoundPlus,
  type LucideIcon,
} from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ExpenseDetailSheets } from '@/components/expense/ExpenseDetailSheet';
import { useRepeatExpense } from '@/components/expense/RepeatExpense';
import ExpenseForm from '@/components/expense/ExpenseForm';
import { PageHeader } from '@/components/layout/PageHeader';
import { acrossLabel, activityEvents, type ActivityEvent } from '@/lib/history-rows';
import { formatMoney } from '@/lib/money';
import { activitySummary, displayName } from '@/lib/names';
import { useSyncData } from '@/lib/queries';
import type { ActivityItem, ActivityType, Expense, SyncData } from '@/lib/types';
import { useExpenseDetail } from '@/lib/use-expense-detail';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';
import { cn } from '@/lib/utils';

const TYPE_ICON: Record<ActivityType, LucideIcon> = {
  expense_added: ReceiptText,
  expense_updated: PencilLine,
  expense_deleted: Trash2,
  expense_restored: ArchiveRestore,
  payment_added: HandCoins,
  payment_undone: Undo2,
  group_created: Sparkles,
  group_renamed: PencilLine,
  member_joined: UserRoundPlus,
  member_removed: UserRoundMinus,
  friend_added: HeartHandshake,
  guest_added: UserRoundPlus,
  guest_renamed: PencilLine,
  guest_removed: UserRoundMinus,
  guest_claimed: UserRoundCheck,
};

function dayLabel(iso: string): string {
  const d = parseDateSafe(iso);
  if (!d) return 'Earlier';
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'MMMM d, yyyy');
}

/** "3:42 PM · 2 hours ago" — the day is the section heading. */
function TimeLine({ iso }: { iso: string }) {
  const d = parseDateSafe(iso);
  if (!d) return null;
  const ago = formatDistanceToNow(d, { addSuffix: true });
  return (
    <time
      dateTime={iso}
      title={format(d, 'EEEE, MMMM d, yyyy · h:mm a')}
      className="text-xs text-muted-foreground"
    >
      {format(d, 'h:mm a')}
      {/* Clock skew can put a fresh item in the future: skip “in 2 hours”. */}
      {ago.startsWith('in ') ? null : ` · ${ago}`}
    </time>
  );
}

export default function Activity() {
  const { data: sync } = useSyncData();
  const { onRepeat, repeatForm } = useRepeatExpense(sync);
  const detail = useExpenseDetail(sync);
  const [editing, setEditing] = useState<Expense | undefined>();
  const [expenseOpen, setExpenseOpen] = useState(false);

  if (!sync) return <ActivitySkeleton />;

  const expensesById = new Map(sync.expenses.map((e) => [e.id, e]));
  const batchesById = new Map((sync.settlementBatches ?? []).map((b) => [b.id, b]));
  const events = activityEvents(sync.activity, expensesById, batchesById);
  const days: { label: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const label = dayLabel(event.createdAt);
    const last = days[days.length - 1];
    if (last && last.label === label) last.events.push(event);
    else days.push({ label, events: [event] });
  }
  const directFriendId =
    editing && editing.groupId === null
      ? editing.shares.find((s) => s.userId !== sync.me.id)?.userId
      : undefined;

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Activity" />
      {days.length === 0 ? (
        <Empty className="rounded-card bg-card py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <CalendarClock />
            </EmptyMedia>
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>
              Expenses, payments, and group changes will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map(({ label, events: dayEvents }) => (
            <section key={label} className="flex flex-col gap-2">
              <h2 className="px-1 text-sm font-medium text-muted-foreground">{label}</h2>
              <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
                {dayEvents.map((event) =>
                  event.kind === 'batch' ? (
                    <BatchEvent
                      key={event.key}
                      event={event}
                      sync={sync}
                      expensesById={expensesById}
                      onOpen={() => detail.openBatch(event.batch)}
                    />
                  ) : (
                    <ItemEvent
                      key={event.key}
                      item={event.item}
                      sync={sync}
                      expense={
                        event.item.expenseId !== null
                          ? expensesById.get(event.item.expenseId)
                          : undefined
                      }
                      onOpenExpense={detail.open}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={editing?.groupId ?? null}
        expense={editing}
        friendId={directFriendId}
      />
      <ExpenseDetailSheets onRepeat={onRepeat}
        detail={detail}
        onEdit={(e) => {
          setEditing(e);
          setExpenseOpen(true);
        }}
      />
      {repeatForm}
    </div>
  );
}

const rowButton =
  'flex min-h-16 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

function EventIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background">
      <Icon className="size-4 text-foreground/70" aria-hidden="true" />
    </span>
  );
}

/** One activity item: opens its expense (detail or receipt), group, or friend. */
function ItemEvent({
  item,
  sync,
  expense,
  onOpenExpense,
}: {
  item: ActivityItem;
  sync: SyncData;
  expense: Expense | undefined;
  onOpenExpense: (e: Expense) => void;
}) {
  const navigate = useOverlayNavigate();
  const content = (
    <>
      <EventIcon icon={TYPE_ICON[item.type] ?? ReceiptText} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm break-words">{activitySummary(item.summary, sync.me)}</span>
        <TimeLine iso={item.createdAt} />
      </span>
    </>
  );

  let open: (() => void) | null = null;
  if (expense && expense.id > 0) {
    open = () => onOpenExpense(expense);
  } else if (item.type === 'friend_added' && sync.friendIds.includes(item.actorId)) {
    open = () => navigate(`/friends/${item.actorId}`);
  } else if (item.groupId !== null && sync.groups.some((g) => g.id === item.groupId)) {
    // Deleted expenses, member and guest changes: the group they happened in.
    open = () => navigate(`/groups/${item.groupId}`);
  }
  if (!open) return <div className="flex min-h-16 items-center gap-3 py-3">{content}</div>;
  return (
    <button type="button" onClick={open} className={rowButton}>
      {content}
    </button>
  );
}

/** One settle-up recorded as several payment rows, shown as one event. */
function BatchEvent({
  event,
  sync,
  expensesById,
  onOpen,
}: {
  event: Extract<ActivityEvent, { kind: 'batch' }>;
  sync: SyncData;
  expensesById: Map<number, Expense>;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { batch } = event;
  const meId = sync.me.id;
  const usersById = new Map(sync.users.map((u) => [u.id, u]));
  const rows = sync.expenses.filter((e) => e.settlementBatchId === batch.id);
  const shown =
    rows.length > 0
      ? rows
      : event.items
          .map((i) => (i.expenseId !== null ? expensesById.get(i.expenseId) : undefined))
          .filter((e): e is Expense => e !== undefined);
  const across = acrossLabel(shown);
  const amount = formatMoney(batch.amountCents, batch.currency);
  const line = `${displayName(usersById.get(batch.payerId), meId)} paid ${displayName(
    usersById.get(batch.payeeId),
    meId,
    { case: 'object' },
  )} ${amount}`;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onOpen} className={cn(rowButton, 'flex-1')}>
          <EventIcon icon={HandCoins} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm break-words">
              {line}
              {across ? <span className="text-muted-foreground"> · {across}</span> : null}
            </span>
            <TimeLine iso={event.createdAt} />
          </span>
        </button>
        {shown.length > 1 ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide where it was applied' : 'Show where it was applied'}
            onClick={() => setExpanded((x) => !x)}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', expanded && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul className="mb-3 ml-13 flex flex-col gap-1.5 rounded-panel bg-muted/50 px-4 py-3 text-sm">
          {shown.map((r) => {
            const group = r.groupId !== null ? sync.groups.find((g) => g.id === r.groupId) : null;
            const payer = r.shares.find((s) => s.paidCents > 0)?.userId;
            const counter = payer !== batch.payerId;
            return (
              <AllocationLine
                key={r.id}
                label={
                  group ? `${group.emoji} ${group.name}` : r.groupId !== null ? 'Group' : 'Direct'
                }
                amount={`${counter ? '−' : ''}${formatMoney(r.amountCents, r.currency)}`}
                muted={counter}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function AllocationLine({
  label,
  amount,
  muted,
}: {
  label: ReactNode;
  amount: string;
  muted: boolean;
}) {
  return (
    <li
      className={cn('flex items-baseline justify-between gap-3', muted && 'text-muted-foreground')}
    >
      <span className="min-w-0 break-words">
        {label}
        {muted ? <span className="text-muted-foreground"> (offset)</span> : null}
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">{amount}</span>
    </li>
  );
}

function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-6">
      <Skeleton className="h-11 w-40 rounded-full" />
      <Skeleton className="h-48 rounded-card" />
      <Skeleton className="h-48 rounded-card" />
    </div>
  );
}
