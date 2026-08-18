import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { BellRing, Plus, ReceiptText, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import ExpenseForm from '@/components/expense/ExpenseForm';
import SettleUpSheet from '@/components/expense/SettleUpSheet';
import { formatMoney } from '@/lib/money';
import { reminderText, sendReminder } from '@/lib/remind';
import ExpenseHistory from '@/components/group/ExpenseHistory';
import { useOnline } from '@/components/layout/OfflineBanner';
import { friendBalance } from '@/lib/balances';
import { useSyncData } from '@/lib/queries';
import type { Expense } from '@/lib/types';

export default function FriendDetail() {
  const { id } = useParams();
  const friendId = Number(id);
  const navigate = useNavigate();
  const online = useOnline();
  const { data: sync, isFetching: syncFetching } = useSyncData();

  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | undefined>();
  const [settleOpen, setSettleOpen] = useState(false);

  if (!sync) return <FriendDetailSkeleton />;

  const friend = sync.users.find((u) => u.id === friendId);
  if (!friend || friend.id === sync.me.id) {
    // Right after accepting a friend the cached dataset may not include them
    // yet — show the skeleton while the refetch is in flight, not "not found".
    if (syncFetching && friend?.id !== sync.me.id) return <FriendDetailSkeleton />;
    return (
      <Empty className="rounded-[28px] bg-card py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-full">
            <UserRound />
          </EmptyMedia>
          <EmptyTitle>Friend not found</EmptyTitle>
          <EmptyDescription>
            This person isn&rsquo;t in your friend list.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" className="rounded-full" onClick={() => navigate('/friends')}>
            Back to friends
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const entries = friendBalance(sync, friend.id).filter((b) => b.netCents !== 0);
  const primary = entries[0];
  const shared = sync.expenses.filter(
    (e) =>
      e.shares.some((s) => s.userId === sync.me.id) &&
      e.shares.some((s) => s.userId === friend.id),
  );

  return (
    <div className="flex flex-col gap-6 pb-6">
      <header className="flex flex-col gap-4 rounded-[28px] bg-card p-6">
        <div className="flex items-center gap-4">
          <UserAvatar user={friend} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-2xl">{friend.name}</h1>
            {friend.email && (
              <span className="truncate text-sm text-muted-foreground">{friend.email}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {entries.length === 0 ? (
            <p className="text-lg text-muted-foreground">You&rsquo;re all settled up</p>
          ) : (
            entries.map((b) => (
              <p key={b.currency} className="text-xl font-medium tracking-tight">
                {b.netCents > 0 ? `${friend.name} owes you ` : 'You owe '}
                <MoneyText signed cents={b.netCents} currency={b.currency} />
              </p>
            ))
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11 rounded-full px-5"
            disabled={!online}
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
            className="h-11 rounded-full px-5"
            disabled={!online}
            onClick={() => setSettleOpen(true)}
          >
            Settle up
          </Button>
          {entries.some((b) => b.netCents > 0) ? (
            <Button
              variant="outline"
              className="h-11 rounded-full px-5"
              onClick={() =>
                void sendReminder(
                  reminderText(
                    friend.name,
                    entries
                      .filter((b) => b.netCents > 0)
                      .map((b) => formatMoney(b.netCents, b.currency))
                      .join(' + '),
                    'overall',
                  ),
                )
              }
            >
              <BellRing data-icon="inline-start" aria-hidden="true" />
              Remind
            </Button>
          ) : null}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <span className="eyebrow">History</span>
        {shared.length === 0 ? (
          <Empty className="rounded-[28px] bg-card py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="rounded-full">
                <ReceiptText />
              </EmptyMedia>
              <EmptyTitle>No shared expenses yet</EmptyTitle>
              <EmptyDescription>
                Expenses you share with {friend.name} — in groups or directly — will show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ExpenseHistory
            sync={sync}
            expenses={shared}
            showGroupTag
            onSelect={(e) => {
              setEditingExpense(e);
              setExpenseOpen(true);
            }}
          />
        )}
      </section>

      <ExpenseForm
        open={expenseOpen}
        onOpenChange={(o) => {
          setExpenseOpen(o);
          if (!o) setEditingExpense(undefined);
        }}
        groupId={editingExpense ? editingExpense.groupId : null}
        expense={editingExpense}
        friendId={friend.id}
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
      <Skeleton className="h-52 rounded-[28px]" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="h-40 rounded-[28px]" />
      </div>
    </div>
  );
}
