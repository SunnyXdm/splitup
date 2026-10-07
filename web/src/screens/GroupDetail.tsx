import { useState } from 'react';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  BellRing,
  ChevronRight,
  Download,
  EllipsisVertical,
  History,
  Link2,
  LogOut,
  PencilLine,
  Plus,
  ReceiptText,
  Repeat,
  Trash2,
  UsersRound,
} from 'lucide-react';
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
import { BackButton } from '@/components/layout/PageHeader';
import { useDocumentTitle } from '@/lib/back-nav';
import { FormSheet } from '@/components/common/FormSheet';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MoneyText } from '@/components/common/MoneyText';
import { GuestPill, UserAvatar } from '@/components/common/UserAvatar';
import ExplainBalanceSheet, { type ExplainTarget } from '@/components/common/ExplainBalanceSheet';
import { DraftsChip } from '@/components/expense/DraftsSheet';
import { ExpenseDetailSheets } from '@/components/expense/ExpenseDetailSheet';
import ExpenseForm from '@/components/expense/ExpenseForm';
import RecentlyDeletedSheet from '@/components/expense/RecentlyDeletedSheet';
import SettleUpSheet, { type SettleDirection } from '@/components/expense/SettleUpSheet';
import AddMembersSheet from '@/components/group/AddMembersSheet';
import { HistoryScopeContext } from '@/components/group/history-scope';
import FilteredHistory from '@/components/search/FilteredHistory';
import GroupSummary from '@/components/summary/GroupSummary';
import GroupFormFields, { type GroupFormValues } from '@/components/group/GroupFormFields';
import { useOnline } from '@/components/layout/OfflineBanner';
import { ApiError, errorMessage, isDepartedMember } from '@/lib/api';
import { buildGroupCsv, downloadCsv } from '@/lib/export-csv';
import { reminderText, sendReminder } from '@/lib/remind';
import { myOpenGroupBalances } from '@/lib/archive';
import { groupBalances, groupExpenses, groupSettlements, type Transfer } from '@/lib/balances';
import { isGuest } from '@/lib/guests';
import { formatMoney } from '@/lib/money';
import { displayName } from '@/lib/names';
import { useDeleteGroup, useLeaveGroup, useSyncData, useUpdateGroup } from '@/lib/queries';
import type { Expense, User } from '@/lib/types';
import { useArchiveToggle } from '@/lib/use-archive-group';
import { useExpenseDetail } from '@/lib/use-expense-detail';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';
import { useParamState } from '@/lib/use-history-filters';
import { cn } from '@/lib/utils';

const TABS = ['expenses', 'balances', 'summary'] as const;

interface SettlePrefill {
  toUserId?: number;
  suggestedCents?: number;
  currency?: string;
  direction?: SettleDirection;
}

export default function GroupDetail() {
  const { id } = useParams();
  const groupId = Number(id);
  // Leave/delete navigate away while their confirm dialog is still open.
  const navigate = useOverlayNavigate();
  const online = useOnline();
  const { data: sync, isFetching: syncFetching } = useSyncData();
  useDocumentTitle(sync?.groups.find((g) => g.id === groupId)?.name);

  const updateGroup = useUpdateGroup();
  const leaveGroup = useLeaveGroup();
  const deleteGroup = useDeleteGroup();
  const toggleArchive = useArchiveToggle();
  const detail = useExpenseDetail(sync);

  const [editValues, setEditValues] = useState<GroupFormValues | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | undefined>();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState<SettlePrefill>({});
  const [addPeopleOpen, setAddPeopleOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [deletedOpen, setDeletedOpen] = useState(false);
  const [explainTarget, setExplainTarget] = useState<ExplainTarget | null>(null);
  // In the URL so a reload (or Back from elsewhere) lands on the same tab.
  const [tab, setTab] = useParamState('tab', TABS, 'expenses');

  if (!sync) return <GroupDetailSkeleton />;

  const group = sync.groups.find((g) => g.id === groupId);
  if (!group) {
    // Right after create/join the cached dataset may not include the group
    // yet — show the skeleton while the refetch is in flight, not "not found".
    if (syncFetching) return <GroupDetailSkeleton />;
    return (
      <div className="flex flex-col gap-4 pb-6">
        <BackButton className="self-start" />
        <Empty className="rounded-card bg-card py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <UsersRound />
            </EmptyMedia>
            <EmptyTitle>Group not found</EmptyTitle>
            <EmptyDescription>
              This group doesn&rsquo;t exist or you&rsquo;re no longer a member.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="pill" onClick={() => navigate('/')}>
              Back home
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const meId = sync.me.id;
  const usersById = new Map(sync.users.map((u) => [u.id, u]));
  const members = group.memberIds
    .map((uid) => usersById.get(uid))
    .filter((u): u is User => u !== undefined);
  const subject = (uid: number) => displayName(usersById.get(uid), meId);
  const object = (uid: number) => displayName(usersById.get(uid), meId, { case: 'object' });
  const expenses = groupExpenses(sync, group.id);
  const balances = groupBalances(sync, group.id);
  const transfers = groupSettlements(sync, group.id);
  const myNets = balances.filter((b) => b.userId === meId && b.netCents !== 0);
  const archived = group.archivedAt != null;
  const stillOwing = archived && myOpenGroupBalances(sync, group.id).length > 0;
  const recurringCount = (sync.recurring?.rules ?? []).filter((r) => r.groupId === group.id).length;
  const justMe = members.length <= 1;
  // "Paid by" choices: current members, plus anyone who paid here before
  // leaving the group.
  const payerIds = new Set(group.memberIds);
  for (const e of expenses) for (const s of e.shares) if (s.paidCents > 0) payerIds.add(s.userId);
  payerIds.delete(meId);
  const payerPeople = [...payerIds]
    .map((uid) => usersById.get(uid))
    .filter((u): u is User => u !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));

  const editExpense = (e: Expense) => {
    setEditingExpense(e);
    setExpenseOpen(true);
  };
  const addExpense = () => {
    setEditingExpense(undefined);
    setExpenseOpen(true);
  };

  const explain = (target: ExplainTarget) => {
    setExplainTarget(target);
    setExplainOpen(true);
  };

  const settleTransfer = (t: Transfer) => {
    setSettlePrefill({
      toUserId: t.toUserId === meId ? t.fromUserId : t.toUserId,
      suggestedCents: t.cents,
      currency: t.currency,
      // Transfer TO me = they pay me; FROM me = I pay.
      direction: t.toUserId === meId ? 'they_paid' : 'i_paid',
    });
    setSettleOpen(true);
  };

  const openSettleUp = () => {
    // Prefill from my largest suggested payment so direction and counterparty
    // are never silently guessed wrong.
    const mine = transfers.filter((t) => t.fromUserId === meId || t.toUserId === meId);
    const best = mine.length ? mine.reduce((a, b) => (b.cents > a.cents ? b : a)) : null;
    if (best) {
      settleTransfer(best);
    } else {
      setSettlePrefill({ currency: group.currency });
      setSettleOpen(true);
    }
  };

  const openEdit = () =>
    setEditValues({ name: group.name, emoji: group.emoji, currency: group.currency });

  const submitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editValues || updateGroup.isPending) return;
    const name = editValues.name.trim();
    if (!name) return;
    updateGroup.mutate(
      { id: group.id, name, emoji: editValues.emoji, currency: editValues.currency },
      {
        onSuccess: () => {
          toast.success('Group updated');
          setEditValues(null);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const confirmLeave = () => {
    leaveGroup.mutate(group.id, {
      onSuccess: () => {
        setLeaveOpen(false);
        toast.success(`You left ${group.name}`);
        navigate('/');
      },
      onError: (err) => {
        setLeaveOpen(false);
        if (err instanceof ApiError && err.status === 409 && !isDepartedMember(err)) {
          toast.error('You have an unsettled balance in this group — settle up before leaving.');
        } else {
          toast.error(errorMessage(err));
        }
      },
    });
  };

  const confirmDelete = () => {
    deleteGroup.mutate(group.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        toast.success('Group deleted');
        navigate('/');
      },
      onError: (err) => {
        setDeleteOpen(false);
        if (err instanceof ApiError && err.status === 409 && !isDepartedMember(err)) {
          toast.error('The group has unsettled balances — settle everyone up before deleting it.');
        } else {
          toast.error(errorMessage(err));
        }
      },
    });
  };

  /** "Darshna Gupta owes you", "You owe Rohan Mehta", "Jake owes Emily". */
  const transferSentence = (t: Transfer) =>
    t.fromUserId === meId
      ? `You owe ${object(t.toUserId)}`
      : `${subject(t.fromUserId)} owes ${object(t.toUserId)}`;

  return (
    <div className="flex flex-col gap-5 pb-6">
      <header className="flex flex-col gap-2">
        {/* Row 1: back, identity, the group's ⋯. The name wraps to two lines. */}
        <div className="flex items-start gap-3">
          <BackButton />
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-2xl"
            aria-hidden="true"
          >
            {group.emoji}
          </span>
          <h1
            tabIndex={-1}
            className="line-clamp-2 min-w-0 flex-1 self-center text-2xl leading-tight font-medium tracking-[-0.02em] break-words outline-none"
          >
            {group.name}
          </h1>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon" className="size-11 rounded-full" />}
            >
              <EllipsisVertical aria-hidden="true" />
              <span className="sr-only">Group options</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={openEdit}>
                <PencilLine aria-hidden="true" /> Edit group
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  downloadCsv(`${group.name}.csv`, buildGroupCsv(sync, group.id));
                  toast.success('Expenses exported');
                }}
              >
                <Download aria-hidden="true" /> Export expenses
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!online} onClick={() => toggleArchive(group, !archived)}>
                {archived ? (
                  <>
                    <ArchiveRestore aria-hidden="true" /> Unarchive
                  </>
                ) : (
                  <>
                    <Archive aria-hidden="true" /> Archive
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setLeaveOpen(true)}>
                <LogOut aria-hidden="true" /> Leave group
              </DropdownMenuItem>
              {group.createdBy === meId && (
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                  <Trash2 aria-hidden="true" /> Delete group
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Row 2: who's in it — one button that opens People. */}
        <button
          type="button"
          onClick={() => setAddPeopleOpen(true)}
          aria-label={`People: ${memberCountLabel(members)}. Manage members and invites.`}
          className="-ml-1 flex min-h-11 w-fit max-w-full items-center gap-2 rounded-full py-1 pr-3 pl-1 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="flex shrink-0 -space-x-2">
            {members.slice(0, 5).map((u) => (
              <UserAvatar key={u.id} user={u} size="sm" className="ring-2 ring-background" />
            ))}
          </span>
          <span className="text-sm whitespace-nowrap text-muted-foreground">
            {memberCountLabel(members)}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </header>

      {/* Summary band: where I stand here, and the way to settle it. */}
      {justMe ? null : (
        <section
          aria-label="Your balance in this group"
          className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card bg-card px-5 py-4"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {myNets.length === 0 ? (
              <p className="text-base">
                You&rsquo;re settled up <span className="text-muted-foreground">in this group</span>
              </p>
            ) : (
              myNets.map((b) => (
                <button
                  key={b.currency}
                  type="button"
                  onClick={() =>
                    explain({
                      kind: 'group',
                      groupId: group.id,
                      currency: b.currency,
                      focusId: meId,
                      otherId: null,
                    })
                  }
                  aria-label={`You ${b.netCents > 0 ? 'get back' : 'owe'} ${formatMoney(
                    Math.abs(b.netCents),
                    b.currency,
                  )} in this group. Balance breakdown.`}
                  className="flex min-h-11 w-fit max-w-full flex-col items-start rounded-panel text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <span className="text-sm text-muted-foreground">
                    {b.netCents > 0 ? 'You get back' : 'You owe'}
                  </span>
                  <MoneyText
                    signed
                    animate
                    cents={b.netCents}
                    currency={b.currency}
                    className="text-2xl font-medium tracking-tight whitespace-nowrap"
                  />
                </button>
              ))
            )}
          </div>
          <Button
            variant={myNets.length > 0 ? 'default' : 'outline'}
            size="pill"
            disabled={!online}
            onClick={openSettleUp}
          >
            Settle up
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </section>
      )}

      {archived && (
        <p className="-mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <Archive className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Archived — hidden from your Home.
            {stillOwing ? ' You still have a balance here.' : null}
          </span>
        </p>
      )}

      <DraftsChip scope={{ kind: 'group', groupId: group.id }} className="self-start" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof TABS)[number])} className="gap-4">
        <TabsList className="w-full rounded-full p-1">
          <TabsTrigger value="expenses" className="rounded-full">
            Expenses
          </TabsTrigger>
          <TabsTrigger value="balances" className="rounded-full">
            Balances
          </TabsTrigger>
          <TabsTrigger value="summary" className="rounded-full">
            Summary
          </TabsTrigger>
        </TabsList>

        <TabsContent value="expenses" className="flex flex-col gap-4">
          <HistoryScopeContext value={{ kind: 'group', groupId: group.id }}>
            <FilteredHistory
              sync={sync}
              expenses={expenses}
              people={payerPeople}
              onSelect={detail.open}
              placeholder={`Search ${group.name}`}
              empty={
                justMe ? (
                  <Empty className="rounded-card bg-card py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon" className="rounded-full">
                        <UsersRound />
                      </EmptyMedia>
                      <EmptyTitle>Invite people first</EmptyTitle>
                      <EmptyDescription>
                        Add friends, share an invite link, or add guests who don&rsquo;t use
                        Splitup. Then split your first bill.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button size="cta" onClick={() => setAddPeopleOpen(true)}>
                        <Link2 data-icon="inline-start" aria-hidden="true" />
                        Invite people
                      </Button>
                    </EmptyContent>
                  </Empty>
                ) : (
                  <Empty className="rounded-card bg-card py-12">
                    <EmptyHeader>
                      <EmptyMedia variant="icon" className="rounded-full">
                        <ReceiptText />
                      </EmptyMedia>
                      <EmptyTitle>No expenses yet</EmptyTitle>
                      <EmptyDescription>
                        Add a bill and Splitup works out who owes whom.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button size="cta" onClick={addExpense}>
                        <Plus data-icon="inline-start" aria-hidden="true" />
                        Add expense
                      </Button>
                    </EmptyContent>
                  </Empty>
                )
              }
            />
          </HistoryScopeContext>
          {/* Quiet links at the end of the list: schedules and recovery. */}
          <nav aria-label="More for this group" className="flex flex-col">
            <QuietLink
              icon={<Repeat aria-hidden="true" />}
              onClick={() => navigate(`/recurring?group=${group.id}`)}
            >
              {recurringCount === 0
                ? 'Recurring bills'
                : `${recurringCount} recurring ${recurringCount === 1 ? 'bill' : 'bills'}`}
            </QuietLink>
            <QuietLink
              icon={<History aria-hidden="true" />}
              disabled={!online}
              onClick={() => setDeletedOpen(true)}
            >
              Recently deleted
            </QuietLink>
          </nav>
        </TabsContent>

        <TabsContent value="summary">
          <GroupSummary sync={sync} groupId={group.id} onSelect={detail.open} />
        </TabsContent>

        <TabsContent value="balances">
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <h2 className="eyebrow px-1">Member balances</h2>
              <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
                {members.map((u) => (
                  <MemberRow
                    key={u.id}
                    user={u}
                    isMe={u.id === meId}
                    nets={balances.filter((b) => b.userId === u.id && b.netCents !== 0)}
                    onExplain={(currency) =>
                      explain({
                        kind: 'group',
                        groupId: group.id,
                        currency,
                        focusId: u.id,
                        otherId: null,
                      })
                    }
                  />
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="eyebrow px-1">Payments to settle up</h2>
              {transfers.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">Everyone is settled up.</p>
              ) : (
                <>
                  <p className="px-1 text-sm text-muted-foreground">
                    Splitup simplifies the group&rsquo;s debts into as few payments as possible, so
                    you may pay someone you never split a bill with. Tap a payment to see why.
                  </p>
                  <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
                    {transfers.map((t, i) => {
                      const involved = t.fromUserId === meId || t.toUserId === meId;
                      const other = t.fromUserId === meId ? t.toUserId : t.fromUserId;
                      const sentence = transferSentence(t);
                      const amount = formatMoney(t.cents, t.currency);
                      return (
                        <div
                          key={`${t.fromUserId}-${t.toUserId}-${t.currency}-${i}`}
                          className="relative py-2"
                        >
                          <button
                            type="button"
                            aria-label={`${sentence} ${amount}. Why?`}
                            onClick={() =>
                              explain({
                                kind: 'group',
                                groupId: group.id,
                                currency: t.currency,
                                // From my side when I'm in it; else the creditor's.
                                focusId: involved ? meId : t.toUserId,
                                otherId: involved ? other : t.fromUserId,
                              })
                            }
                            className="flex w-full flex-col items-start gap-0.5 rounded-panel py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                          >
                            <span className="pr-1 text-base break-words">{sentence}</span>
                            <span className="flex min-h-11 items-center text-lg font-medium whitespace-nowrap tabular-nums underline decoration-muted-foreground/60 decoration-dotted underline-offset-4">
                              {amount}
                            </span>
                          </button>
                          {involved ? (
                            <div className="absolute right-0 bottom-3 flex items-center gap-1">
                              {t.toUserId === meId ? (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-11 rounded-full"
                                  aria-label={`Remind ${subject(t.fromUserId)}`}
                                  onClick={() =>
                                    void sendReminder(
                                      reminderText(
                                        subject(t.fromUserId),
                                        amount,
                                        `in "${group.name}"`,
                                        // Guests can't sign in: no sign-in link for them.
                                        { withLink: !isGuest(usersById.get(t.fromUserId)) },
                                      ),
                                    )
                                  }
                                >
                                  <BellRing aria-hidden="true" />
                                </Button>
                              ) : null}
                              <Button
                                variant="outline"
                                size="pill"
                                className="px-4"
                                disabled={!online}
                                onClick={() => settleTransfer(t)}
                              >
                                Settle
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          </div>
        </TabsContent>
      </Tabs>

      <FormSheet
        open={editValues !== null}
        onOpenChange={(o) => !o && setEditValues(null)}
        title="Edit group"
        onSubmit={submitEdit}
        submitLabel="Save changes"
        pending={updateGroup.isPending}
        submitDisabled={!editValues?.name.trim() || updateGroup.isPending || !online}
      >
        {editValues && (
          <GroupFormFields
            values={editValues}
            onChange={setEditValues}
            currencyLocked={sync.expenses.some((e) => e.groupId === group.id)}
          />
        )}
      </FormSheet>

      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {group.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You&rsquo;ll lose access to this group&rsquo;s expenses. You can rejoin later with an
              invite link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-full"
              disabled={leaveGroup.isPending || !online}
              onClick={confirmLeave}
            >
              Leave group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the group and all of its expenses for everyone. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="rounded-full"
              disabled={deleteGroup.isPending || !online}
              onClick={confirmDelete}
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* editingExpense is kept after close: clearing it here flipped the
          sheet to "Add expense" during its close animation. Every open sets it. */}
      <ExpenseForm
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        groupId={group.id}
        expense={editingExpense}
      />
      <ExpenseDetailSheets detail={detail} onEdit={editExpense} />
      <ExplainBalanceSheet
        open={explainOpen}
        onOpenChange={setExplainOpen}
        target={explainTarget}
      />
      <RecentlyDeletedSheet
        open={deletedOpen}
        onOpenChange={setDeletedOpen}
        scope={{ groupId: group.id }}
      />
      <AddMembersSheet open={addPeopleOpen} onOpenChange={setAddPeopleOpen} groupId={group.id} />
      <SettleUpSheet
        open={settleOpen}
        onOpenChange={setSettleOpen}
        groupId={group.id}
        toUserId={settlePrefill.toUserId}
        suggestedCents={settlePrefill.suggestedCents}
        currency={settlePrefill.currency ?? group.currency}
        direction={settlePrefill.direction}
      />
    </div>
  );
}

/** One member's group net(s); tapping explains it (first currency, switchable in the sheet). */
function MemberRow({
  user: u,
  isMe,
  nets,
  onExplain,
}: {
  user: User;
  isMe: boolean;
  nets: { currency: string; netCents: number }[];
  onExplain: (currency: string) => void;
}) {
  const content = (
    <>
      <UserAvatar user={u} />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn('break-words', isMe ? 'font-medium' : null)}>
          {isMe ? 'You' : u.name}
        </span>
        {isGuest(u) ? <GuestPill /> : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {nets.length === 0 ? (
          <span className="text-sm text-muted-foreground">settled up</span>
        ) : (
          nets.map((b) => (
            // Direction in words, not just color.
            <span key={b.currency} className="flex flex-col items-end">
              <span className="text-xs text-muted-foreground">
                {b.netCents > 0 ? (isMe ? 'you get back' : 'gets back') : isMe ? 'you owe' : 'owes'}
              </span>
              <MoneyText
                signed
                animate
                cents={b.netCents}
                currency={b.currency}
                className="text-sm font-medium whitespace-nowrap"
              />
            </span>
          ))
        )}
      </span>
      {nets.length > 0 ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </>
  );
  if (nets.length === 0) {
    return <div className="flex min-h-16 items-center gap-3 py-3">{content}</div>;
  }
  const first = nets[0];
  const subject = isMe ? 'do you' : `does ${u.name}`;
  return (
    <button
      type="button"
      aria-label={`Why ${subject} ${first.netCents > 0 ? 'get back' : 'owe'} ${formatMoney(
        Math.abs(first.netCents),
        first.currency,
      )}?`}
      onClick={() => onExplain(first.currency)}
      className="flex min-h-16 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {content}
    </button>
  );
}

/** A quiet full-width row link (icon, label, chevron) — secondary destinations. */
function QuietLink({
  icon,
  children,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-12 w-full items-center gap-3 rounded-full px-3 text-left text-sm text-muted-foreground outline-none hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight className="text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** "Just you", "3 members", "2 members · 1 guest" — guests counted apart. */
function memberCountLabel(members: User[]): string {
  const guests = members.filter((u) => isGuest(u)).length;
  const people = members.length - guests;
  const base = people === 1 ? 'Just you' : `${people} members`;
  return guests === 0 ? base : `${base} · ${guests} ${guests === 1 ? 'guest' : 'guests'}`;
}

function GroupDetailSkeleton() {
  return (
    <div className="flex flex-col gap-5 pb-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="size-11 rounded-full" />
        <Skeleton className="h-7 flex-1 rounded-full" />
      </div>
      <Skeleton className="h-9 w-40 rounded-full" />
      <Skeleton className="h-20 rounded-card" />
      <Skeleton className="h-11 rounded-full" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  );
}
