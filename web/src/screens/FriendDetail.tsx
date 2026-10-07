import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  BellRing,
  ChevronRight,
  EllipsisVertical,
  History,
  Plus,
  ReceiptText,
  UserRound,
} from 'lucide-react';
import { BackButton } from '@/components/layout/PageHeader';
import { useDocumentTitle } from '@/lib/back-nav';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { MoneyText } from '@/components/common/MoneyText';
import { UserAvatar } from '@/components/common/UserAvatar';
import { DraftsChip } from '@/components/expense/DraftsSheet';
import { ExpenseDetailSheets } from '@/components/expense/ExpenseDetailSheet';
import ExpenseForm from '@/components/expense/ExpenseForm';
import RecentlyDeletedSheet from '@/components/expense/RecentlyDeletedSheet';
import SettleUpSheet from '@/components/expense/SettleUpSheet';
import ExplainBalanceSheet from '@/components/common/ExplainBalanceSheet';
import { HistoryScopeContext } from '@/components/group/history-scope';
import { formatMoney } from '@/lib/money';
import { reminderText, sendReminder } from '@/lib/remind';
import FilteredHistory from '@/components/search/FilteredHistory';
import { useOnline } from '@/components/layout/OfflineBanner';
import { friendBalance } from '@/lib/balances';
import { useSyncData } from '@/lib/queries';
import type { Expense } from '@/lib/types';
import { useExpenseDetail } from '@/lib/use-expense-detail';

export default function FriendDetail() {
  const { id } = useParams();
  const friendId = Number(id);
  const navigate = useNavigate();
  const online = useOnline();
  const { data: sync, isFetching: syncFetching } = useSyncData();
  useDocumentTitle(sync?.users.find((u) => u.id === friendId)?.name);
  const detail = useExpenseDetail(sync);

  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | undefined>();
  const [settleOpen, setSettleOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainCurrency, setExplainCurrency] = useState<string | null>(null);
  const [deletedOpen, setDeletedOpen] = useState(false);

  // Stable per snapshot, so the filtered history below memoizes properly.
  const shared = useMemo(
    () =>
      sync
        ? sync.expenses.filter(
            (e) =>
              e.shares.some((s) => s.userId === sync.me.id) &&
              e.shares.some((s) => s.userId === friendId),
          )
        : [],
    [sync, friendId],
  );

  if (!sync) return <FriendDetailSkeleton />;

  // Only actual friends: sync.users also holds co-members, guests and former
  // share holders, none of whom has a friend page.
  const isFriend = sync.friendIds.includes(friendId);
  const friend = isFriend ? sync.users.find((u) => u.id === friendId) : undefined;
  if (!friend || friend.id === sync.me.id) {
    // Right after accepting a friend the cached dataset may not include them
    // yet — show the skeleton while the refetch is in flight, not "not found".
    if (syncFetching && friendId !== sync.me.id) return <FriendDetailSkeleton />;
    return (
      <div className="flex flex-col gap-4 pb-6">
        <BackButton className="self-start" />
        <Empty className="rounded-card bg-card py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <UserRound />
            </EmptyMedia>
            <EmptyTitle>Friend not found</EmptyTitle>
            <EmptyDescription>This person isn&rsquo;t in your friend list.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="pill" onClick={() => navigate('/friends')}>
              Back to friends
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const entries = friendBalance(sync, friend.id).filter((b) => b.netCents !== 0);
  const primary = entries[0];
  const owedToMe = entries.filter((b) => b.netCents > 0);

  const editExpense = (e: Expense) => {
    setEditingExpense(e);
    setExpenseOpen(true);
  };

  return (
    <div className="flex flex-col gap-6 pb-6">
      <header className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <BackButton />
          <UserAvatar user={friend} size="lg" className="size-11" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 self-center">
            <h1
              tabIndex={-1}
              className="text-2xl leading-tight font-medium tracking-[-0.02em] break-words outline-none"
            >
              {friend.name}
            </h1>
            {friend.email && (
              <span className="text-sm break-all text-muted-foreground">{friend.email}</span>
            )}
          </div>
        </div>

        {/* One compact row per currency; each opens its balance breakdown. */}
        <section aria-label="Balance" className="flex flex-col rounded-card bg-card px-4">
          {entries.length > 0 ? (
            <h2 className="pt-3 text-xs text-muted-foreground">
              Balance breakdown — tap an amount to see where it comes from
            </h2>
          ) : null}
          {entries.length === 0 ? (
            <p className="flex min-h-14 items-center text-base text-muted-foreground">
              You&rsquo;re all settled up
            </p>
          ) : (
            entries.map((b) => {
              const owesMe = b.netCents > 0;
              const amount = formatMoney(Math.abs(b.netCents), b.currency);
              return (
                <button
                  key={b.currency}
                  type="button"
                  aria-label={`Balance breakdown: ${
                    owesMe ? `${friend.name} owes you` : `you owe ${friend.name}`
                  } ${amount}`}
                  onClick={() => {
                    setExplainCurrency(b.currency);
                    setExplainOpen(true);
                  }}
                  className="flex min-h-14 w-full items-center gap-3 border-b border-border/60 py-2 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <span className="min-w-0 flex-1 text-base text-muted-foreground">
                    {owesMe ? 'Owes you' : 'You owe'}
                  </span>
                  <MoneyText
                    signed
                    animate
                    cents={b.netCents}
                    currency={b.currency}
                    className="text-xl font-medium tracking-tight whitespace-nowrap"
                  />
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              );
            })
          )}
        </section>

        <div className="flex items-center gap-2">
          {/* Works offline too: the expense is kept as a draft. */}
          <Button
            size="cta"
            className="min-w-0 flex-1"
            onClick={() => {
              setEditingExpense(undefined);
              setExpenseOpen(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add expense
          </Button>
          <Button
            variant="outline"
            size="pill"
            className="h-12"
            disabled={!online}
            onClick={() => setSettleOpen(true)}
          >
            Settle up
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon" className="size-12 rounded-full" />}
            >
              <EllipsisVertical aria-hidden="true" />
              <span className="sr-only">More for {friend.name}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {owedToMe.length > 0 ? (
                <DropdownMenuItem
                  onClick={() =>
                    void sendReminder(
                      reminderText(
                        friend.name,
                        owedToMe.map((b) => formatMoney(b.netCents, b.currency)).join(' + '),
                        'overall',
                      ),
                    )
                  }
                >
                  <BellRing aria-hidden="true" /> Send a reminder
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!online} onClick={() => setDeletedOpen(true)}>
                <History aria-hidden="true" /> Recently deleted
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DraftsChip scope={{ kind: 'friend', friendId: friend.id }} className="self-start" />
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow px-1">History</h2>
        <HistoryScopeContext value={{ kind: 'friend', friendId: friend.id }}>
          <FilteredHistory
            sync={sync}
            expenses={shared}
            people={[friend]}
            showGroupTag
            collapseBatches
            placeholder={`Search expenses with ${friend.name}`}
            onSelect={detail.open}
            empty={
              <Empty className="rounded-card bg-card py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon" className="rounded-full">
                    <ReceiptText />
                  </EmptyMedia>
                  <EmptyTitle>No shared expenses yet</EmptyTitle>
                  <EmptyDescription>
                    Expenses you share with {friend.name} — in groups or directly — will show up
                    here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            }
          />
        </HistoryScopeContext>
        {shared.length > 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            Group bills show your share. What {friend.name} owes you overall is in the balance
            breakdown.
          </p>
        ) : null}
      </section>

      {/* editingExpense is kept after close (clearing it flipped the sheet to
          "Add expense" mid-animation); "Add expense" resets it before opening. */}
      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={editingExpense ? editingExpense.groupId : null}
        expense={editingExpense}
        friendId={friend.id}
      />
      <ExpenseDetailSheets detail={detail} onEdit={editExpense} />
      <ExplainBalanceSheet
        open={explainOpen}
        onOpenChange={setExplainOpen}
        target={
          explainCurrency === null
            ? null
            : { kind: 'friend', friendId: friend.id, currency: explainCurrency }
        }
      />
      <RecentlyDeletedSheet
        open={deletedOpen}
        onOpenChange={setDeletedOpen}
        scope={{ friendId: friend.id }}
      />
      <SettleUpSheet
        open={settleOpen}
        onOpenChange={setSettleOpen}
        groupId={null}
        toUserId={friend.id}
        suggestedCents={primary ? Math.abs(primary.netCents) : undefined}
        currency={primary?.currency ?? sync.me.defaultCurrency}
        // + net = the friend owes me, so the settling payment is THEM paying.
        direction={primary && primary.netCents > 0 ? 'they_paid' : 'i_paid'}
      />
    </div>
  );
}

function FriendDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="h-7 flex-1 rounded-full" />
      </div>
      <Skeleton className="h-20 rounded-card" />
      <Skeleton className="h-12 rounded-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="h-40 rounded-card" />
      </div>
    </div>
  );
}
