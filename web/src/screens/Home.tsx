import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Archive, ChartPie, ChevronRight, FilePenLine, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FormSheet } from '@/components/common/FormSheet';
import { MoneyText } from '@/components/common/MoneyText';
import { useDraftsUi } from '@/components/expense/drafts-ui';
import { GROUP_EMOJI } from '@/components/group/group-emoji';
import GroupFormFields, { type GroupFormValues } from '@/components/group/GroupFormFields';
import { BalanceHero, WelcomeHero } from '@/components/home/BalanceHero';
import { useOnline } from '@/components/layout/OfflineBanner';
import { DueBillsRow } from '@/components/recurring/DueToAdd';
import { AddFriendSheet } from '@/screens/Friends';
import { myOpenGroupBalances, partitionGroups } from '@/lib/archive';
import { myGrossBalances, orderByCurrency, type NetBalance } from '@/lib/balances';
import { useDocumentTitle } from '@/lib/back-nav';
import { useDrafts } from '@/lib/draft-store';
import { formatMoney } from '@/lib/money';
import { resolveDateRange } from '@/lib/search';
import { personalSummary } from '@/lib/summary';
import { errorMessage } from '@/lib/api';
import { useCreateGroup, useSyncData } from '@/lib/queries';
import type { Group, SyncData } from '@/lib/types';
import { useOverlayNavigate } from '@/lib/use-history-dismiss';
import { EntranceScope } from '@/components/common/Entrance';
import { useEnterItem } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * Home: a calm overview. Balances (owed / owe, each tappable) → compact
 * "needs you" rows (bills due, drafts) → Groups → a one-line spending link.
 * On wide screens the overview sits left and the groups right.
 */
export default function Home() {
  const { data: sync } = useSyncData();
  const [createOpen, setCreateOpen] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  useDocumentTitle('Home');

  if (!sync) return <HomeSkeleton />;

  const { active, archived } = partitionGroups(sync.groups);
  // Totals span every group, archived ones included: archiving only tidies
  // the list below, it never hides money.
  const gross = myGrossBalances(sync);
  const brandNew =
    sync.groups.length === 0 && sync.friendIds.length === 0 && sync.expenses.length === 0;

  return (
    <div className="flex flex-col gap-6 pb-6 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-x-10">
      <h1 className="sr-only">Home</h1>
      <div className="flex flex-col gap-6 lg:sticky lg:top-28">
        {brandNew ? (
          <WelcomeHero
            onNewGroup={() => setCreateOpen(true)}
            onAddFriend={() => setAddFriendOpen(true)}
          />
        ) : (
          <BalanceHero gross={gross} defaultCurrency={sync.me.defaultCurrency} />
        )}
        {/* Things waiting on me; collapses away when there are none. */}
        <div className="flex flex-col gap-3 empty:hidden">
          <DueBillsRow sync={sync} />
          <DraftsRow userId={sync.me.id} />
        </div>
        {sync.expenses.length > 0 ? (
          <InsightsLink sync={sync} className="-mt-3 hidden lg:flex" />
        ) : null}
      </div>

      {brandNew ? null : (
        <section aria-labelledby="groups-title" className="flex flex-col gap-3">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <h2 id="groups-title" className="text-xl font-medium tracking-[-0.02em]">
              Groups
            </h2>
            <Button variant="outline" size="pill" onClick={() => setCreateOpen(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              New group
            </Button>
          </div>
          {sync.groups.length === 0 ? (
            <NoGroups onCreate={() => setCreateOpen(true)} />
          ) : active.length > 0 ? (
            <EntranceScope id="home-groups">
              <GroupList sync={sync} groups={active} />
            </EntranceScope>
          ) : (
            <p className="px-1 text-muted-foreground">All your groups are archived.</p>
          )}
          {archived.length > 0 ? <ArchivedLink count={archived.length} /> : null}
          {sync.expenses.length > 0 ? <InsightsLink sync={sync} className="lg:hidden" /> : null}
        </section>
      )}

      <NewGroupSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultCurrency={sync.me.defaultCurrency}
      />
      <AddFriendSheet open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </div>
  );
}

/** Saved offline drafts, as one row that opens the drafts list. */
function DraftsRow({ userId }: { userId: number }) {
  const drafts = useDrafts(userId);
  const { openDrafts } = useDraftsUi();
  const count = drafts?.drafts.length ?? 0;
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={() => openDrafts({ kind: 'all' })}
      className="pressable flex min-h-16 w-full items-center gap-3 rounded-card bg-card p-3 pr-4 text-left outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-focus-ring"
    >
      <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
        <FilePenLine className="size-5 text-foreground/70" aria-hidden="true" />
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-signal ring-2 ring-card"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {count === 1 ? '1 draft' : `${count} drafts`} not added yet
        </span>
        <span className="text-sm text-muted-foreground">Saved on this device</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
        Review
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
      </span>
    </button>
  );
}

/** "Your share in October ₹6,448 ›" — the way into Insights. */
function InsightsLink({ sync, className }: { sync: SyncData; className?: string }) {
  const now = new Date();
  const spent = orderByCurrency(
    personalSummary(sync, resolveDateRange('this-month', now)).filter((s) => s.expenseCount > 0),
    sync.me.defaultCurrency,
  );
  const month = now.toLocaleString(undefined, { month: 'long' });
  return (
    <Link
      to="/insights"
      className={cn(
        'pressable flex min-h-14 items-center gap-3 rounded-full px-4 text-muted-foreground transition-colors hover:bg-card hover:text-foreground',
        className,
      )}
    >
      <ChartPie className="size-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Your share in {month}{' '}
        <span className="font-medium text-foreground tabular-nums">
          {spent.length === 0
            ? 'nothing yet'
            : spent.map((s) => formatMoney(s.myShareCents, s.currency)).join(' + ')}
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0" aria-hidden="true" />
    </Link>
  );
}

function GroupList({ sync, groups }: { sync: SyncData; groups: Group[] }) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g, i) => (
        <GroupCard key={g.id} index={i} to={`/groups/${g.id}`}>
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-background text-2xl"
            aria-hidden="true"
          >
            {g.emoji}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="line-clamp-2 font-medium break-words">{g.name}</span>
            <span className="text-sm text-muted-foreground">
              {g.memberIds.length === 1 ? 'Just you' : `${g.memberIds.length} members`}
            </span>
          </span>
          <GroupBalance
            balances={orderByCurrency(myOpenGroupBalances(sync, g.id), sync.me.defaultCurrency)}
          />
        </GroupCard>
      ))}
    </div>
  );
}

/** My balance in a group: amount (direction colour) over its words, per currency. */
function GroupBalance({ balances }: { balances: NetBalance[] }) {
  if (balances.length === 0) {
    return <span className="shrink-0 text-sm text-muted-foreground">settled up</span>;
  }
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      {balances.map((b) => (
        <span key={b.currency} className="flex flex-col items-end leading-tight">
          <MoneyText
            signed
            animate
            cents={b.netCents}
            currency={b.currency}
            className="font-medium"
          />
          <span className="text-sm text-muted-foreground">
            {b.netCents > 0 ? 'you’re owed' : 'you owe'}
          </span>
        </span>
      ))}
    </span>
  );
}

function GroupCard({ index, to, children }: { index: number; to: string; children: ReactNode }) {
  const enter = useEnterItem(index);
  return (
    <Link
      to={to}
      className={cn(
        'pressable flex min-h-20 items-center gap-4 rounded-card bg-card p-4 hover:bg-secondary',
        enter.className,
      )}
      style={enter.style}
    >
      {children}
    </Link>
  );
}

/** Quiet row under the list: the way into groups I archived. */
function ArchivedLink({ count }: { count: number }) {
  return (
    <Link
      to="/groups/archived"
      className="flex min-h-12 items-center gap-3 rounded-full px-4 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
    >
      <Archive className="size-5 shrink-0" aria-hidden="true" />
      <span className="flex-1">Archived groups ({count})</span>
      <ChevronRight className="size-5 shrink-0" aria-hidden="true" />
    </Link>
  );
}

function NoGroups({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-card bg-card p-6">
      <div className="flex flex-col gap-1">
        <p className="font-medium">No groups yet</p>
        <p className="text-sm text-muted-foreground">
          Make one for your flat, a trip or a regular dinner — or join one from an invite link.
        </p>
      </div>
      <Button variant="outline" size="pill" onClick={onCreate}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        New group
      </Button>
    </div>
  );
}

function NewGroupSheet({
  open,
  onOpenChange,
  defaultCurrency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCurrency: string;
}) {
  // Navigates to the new group while this sheet is still open.
  const navigate = useOverlayNavigate();
  const online = useOnline();
  const createGroup = useCreateGroup();
  const [values, setValues] = useState<GroupFormValues>({
    name: '',
    emoji: GROUP_EMOJI[0],
    currency: defaultCurrency,
  });

  const handleOpenChange = (next: boolean) => {
    if (next) setValues({ name: '', emoji: GROUP_EMOJI[0], currency: defaultCurrency });
    onOpenChange(next);
  };

  const submit = () => {
    const name = values.name.trim();
    if (!name || createGroup.isPending) return;
    createGroup.mutate(
      { name, emoji: values.emoji, currency: values.currency },
      {
        onSuccess: (group) => {
          toast.success(`Created ${group.name}`);
          onOpenChange(false);
          navigate(`/groups/${group.id}`);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="New group"
      onSubmit={submit}
      submitLabel="Create group"
      pending={createGroup.isPending}
      submitDisabled={!values.name.trim() || createGroup.isPending || !online}
    >
      <GroupFormFields values={values} onChange={setValues} />
    </FormSheet>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-6 pb-6">
      <Skeleton className="h-52 rounded-hero" />
      <Skeleton className="h-16 rounded-card" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-20 rounded-card" />
      </div>
    </div>
  );
}
