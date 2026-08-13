import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  BellRing,
  Download,
  EllipsisVertical,
  LogOut,
  MoveRight,
  PencilLine,
  ReceiptText,
  Trash2,
  UserRoundPlus,
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { UserAvatar } from '@/components/common/UserAvatar';
import ExpenseForm from '@/components/expense/ExpenseForm';
import SettleUpSheet, { type SettleDirection } from '@/components/expense/SettleUpSheet';
import AddMembersSheet from '@/components/group/AddMembersSheet';
import ExpenseHistory from '@/components/group/ExpenseHistory';
import GroupFormFields, { type GroupFormValues } from '@/components/group/GroupFormFields';
import { useOnline } from '@/components/layout/OfflineBanner';
import { ApiError } from '@/lib/api';
import { buildGroupCsv, downloadCsv } from '@/lib/export-csv';
import { reminderText, sendReminder } from '@/lib/remind';
import { groupBalances, suggestSettlements } from '@/lib/balances';
import { formatMoney } from '@/lib/money';
import {
  useDeleteGroup,
  useLeaveGroup,
  useSyncData,
  useUpdateGroup,
} from '@/lib/queries';
import type { Expense, User } from '@/lib/types';

interface SettlePrefill {
  toUserId?: number;
  suggestedCents?: number;
  currency?: string;
  direction?: SettleDirection;
}

export default function GroupDetail() {
  const { id } = useParams();
  const groupId = Number(id);
  const navigate = useNavigate();
  const online = useOnline();
  const { data: sync, isFetching: syncFetching } = useSyncData();

  const updateGroup = useUpdateGroup();
  const leaveGroup = useLeaveGroup();
  const deleteGroup = useDeleteGroup();

  const [editValues, setEditValues] = useState<GroupFormValues | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | undefined>();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState<SettlePrefill>({});
  const [addPeopleOpen, setAddPeopleOpen] = useState(false);

  if (!sync) return <GroupDetailSkeleton />;

  const group = sync.groups.find((g) => g.id === groupId);
  if (!group) {
    // Right after create/join the cached dataset may not include the group
    // yet — show the skeleton while the refetch is in flight, not "not found".
    if (syncFetching) return <GroupDetailSkeleton />;
    return (
      <Empty className="rounded-[28px] bg-card py-16">
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
          <Button variant="outline" className="rounded-full" onClick={() => navigate('/')}>
            Back home
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const meId = sync.me.id;
  const usersById = new Map(sync.users.map((u) => [u.id, u]));
  const members = group.memberIds
    .map((uid) => usersById.get(uid))
    .filter((u): u is User => u !== undefined);
  const nameOf = (uid: number) => (uid === meId ? 'You' : (usersById.get(uid)?.name ?? 'Someone'));
  const expenses = sync.expenses.filter((e) => e.groupId === group.id);
  const balances = groupBalances(sync, group.id);
  const transfers = suggestSettlements(balances);

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
        onError: (err) => toast.error(err.message),
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
        if (err instanceof ApiError && err.status === 409) {
          toast.error('You have an unsettled balance in this group — settle up before leaving.');
        } else {
          toast.error(err.message);
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
        toast.error(err.message);
      },
    });
  };

  return (
    <div className="flex flex-col gap-6 pb-6">
      <header className="flex flex-wrap items-center gap-4">
        <span
          className="flex size-14 shrink-0 items-center justify-center rounded-full bg-card text-3xl"
          aria-hidden="true"
        >
          {group.emoji}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate text-2xl">{group.name}</h1>
          <div className="flex items-center gap-2">
            <div className="flex -space-x-2">
              {members.slice(0, 6).map((u) => (
                <UserAvatar key={u.id} user={u} size="sm" className="ring-2 ring-background" />
              ))}
            </div>
            <span className="text-sm text-muted-foreground">
              {members.length === 1 ? 'Just you' : `${members.length} members`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-full px-4"
            onClick={() => setAddPeopleOpen(true)}
            disabled={!online}
          >
            <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
            People
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon-lg" className="size-10 rounded-full" />}
            >
              <EllipsisVertical aria-hidden="true" />
              <span className="sr-only">Group options</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
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
      </header>

      <Tabs defaultValue="expenses" className="gap-4">
        <TabsList className="w-full rounded-full p-1 group-data-horizontal/tabs:h-11">
          <TabsTrigger value="expenses" className="rounded-full">
            Expenses
          </TabsTrigger>
          <TabsTrigger value="balances" className="rounded-full">
            Balances
          </TabsTrigger>
        </TabsList>

        <TabsContent value="expenses">
          {expenses.length === 0 ? (
            <Empty className="rounded-[28px] bg-card py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="rounded-full">
                  <ReceiptText />
                </EmptyMedia>
                <EmptyTitle>No expenses yet</EmptyTitle>
                <EmptyDescription>Add the first expense with the + button.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ExpenseHistory
              sync={sync}
              expenses={expenses}
              onSelect={(e) => {
                setEditingExpense(e);
                setExpenseOpen(true);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="balances">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
              {members.map((u) => {
                const nets = balances.filter((b) => b.userId === u.id && b.netCents !== 0);
                return (
                  <div key={u.id} className="flex min-h-16 items-center gap-3 py-3">
                    <UserAvatar user={u} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {u.id === meId ? 'You' : u.name}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      {nets.length === 0 ? (
                        <span className="text-sm text-muted-foreground">settled up</span>
                      ) : (
                        nets.map((b) => (
                          <MoneyText
                            key={b.currency}
                            signed
                            cents={b.netCents}
                            currency={b.currency}
                            className="text-sm font-medium"
                          />
                        ))
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            <section className="flex flex-col gap-3">
              <span className="eyebrow">Suggested settlements</span>
              {transfers.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">Everyone is settled up.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
                  {transfers.map((t, i) => {
                    const involved = t.fromUserId === meId || t.toUserId === meId;
                    const other = t.fromUserId === meId ? t.toUserId : t.fromUserId;
                    return (
                      <div
                        key={`${t.fromUserId}-${t.toUserId}-${t.currency}-${i}`}
                        className="flex min-h-14 items-center gap-3 py-3"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                          <span className="truncate font-medium">{nameOf(t.fromUserId)}</span>
                          <MoveRight
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="truncate font-medium">{nameOf(t.toUserId)}</span>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">
                          {formatMoney(t.cents, t.currency)}
                        </span>
                        {t.toUserId === meId ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="rounded-full"
                            aria-label={`Remind ${nameOf(t.fromUserId)}`}
                            onClick={() =>
                              void sendReminder(
                                reminderText(
                                  nameOf(t.fromUserId),
                                  t.cents,
                                  t.currency,
                                  `in "${group.name}"`,
                                ),
                              )
                            }
                          >
                            <BellRing aria-hidden="true" />
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          disabled={!involved || !online}
                          onClick={() => {
                            setSettlePrefill({
                              toUserId: other,
                              suggestedCents: t.cents,
                              currency: t.currency,
                              // Transfer TO me = they pay me; FROM me = I pay.
                              direction: t.toUserId === meId ? 'they_paid' : 'i_paid',
                            });
                            setSettleOpen(true);
                          }}
                        >
                          Settle
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {members.length > 1 && (
                <Button
                  className="h-11 rounded-full"
                  disabled={!online}
                  onClick={() => {
                    setSettlePrefill({ currency: group.currency });
                    setSettleOpen(true);
                  }}
                >
                  Settle up
                </Button>
              )}
            </section>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={editValues !== null} onOpenChange={(o) => !o && setEditValues(null)}>
        <DialogContent>
          <form onSubmit={submitEdit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Edit group</DialogTitle>
            </DialogHeader>
            {editValues && (
              <GroupFormFields
                values={editValues}
                onChange={setEditValues}
                currencyLocked={sync.expenses.some((e) => e.groupId === group.id)}
              />
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={() => setEditValues(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="rounded-full"
                disabled={!editValues?.name.trim() || updateGroup.isPending || !online}
              >
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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

      <ExpenseForm
        open={expenseOpen}
        onOpenChange={(o) => {
          setExpenseOpen(o);
          if (!o) setEditingExpense(undefined);
        }}
        groupId={group.id}
        expense={editingExpense}
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

function GroupDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-6">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-6 w-40 rounded-full" />
          <Skeleton className="h-4 w-24 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-11 rounded-full" />
      <Skeleton className="h-40 rounded-[28px]" />
    </div>
  );
}
