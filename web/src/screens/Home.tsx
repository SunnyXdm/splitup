import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowUpRight, Plus, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { GROUP_EMOJI } from '@/components/group/group-emoji';
import GroupFormFields, { type GroupFormValues } from '@/components/group/GroupFormFields';
import { useOnline } from '@/components/layout/OfflineBanner';
import { NumberTicker } from '@/components/ui/number-ticker';
import { groupBalances, myTotalBalance, type CurrencyAmount } from '@/lib/balances';
import { formatMoney } from '@/lib/money';
import { useCreateGroup, useSyncData } from '@/lib/queries';
import type { SyncData } from '@/lib/types';

export default function Home() {
  const { data: sync } = useSyncData();
  const [createOpen, setCreateOpen] = useState(false);

  if (!sync) return <HomeSkeleton />;

  const totals = myTotalBalance(sync).filter((t) => t.netCents !== 0);
  return (
    <div className="flex flex-col gap-8 pb-6">
      <BalanceHero totals={totals} />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Groups</span>
          {sync.groups.length > 0 && (
            <Button
              variant="outline"
              className="h-10 rounded-full px-4"
              onClick={() => setCreateOpen(true)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              New group
            </Button>
          )}
        </div>
        {sync.groups.length === 0 ? (
          <NoGroups onCreate={() => setCreateOpen(true)} />
        ) : (
          <GroupList sync={sync} />
        )}
      </section>
      <NewGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultCurrency={sync.me.defaultCurrency}
      />
    </div>
  );
}

/**
 * The signature moment: an ink stadium card with cream text, one thin orange
 * orbital arc and a white satellite circle docked on its edge (→ /activity).
 */
function BalanceHero({ totals }: { totals: CurrencyAmount[] }) {
  return (
    <section className="relative">
      <div className="relative overflow-hidden rounded-[40px] bg-primary px-7 pt-9 pb-12 text-primary-foreground shadow-[0_24px_48px_rgba(0,0,0,0.08)] sm:px-10 sm:pt-11 sm:pb-14">
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox="0 0 400 220"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M -16 198 C 88 176, 148 96, 244 88 C 316 82, 356 118, 424 60"
            fill="none"
            stroke="var(--signal)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            opacity="0.9"
          />
        </svg>
        <div className="relative flex flex-col gap-2">
          <span className="text-sm text-primary-foreground/70">Total balance</span>
          {totals.length === 0 ? (
            <p className="text-3xl font-medium tracking-tight sm:text-4xl">
              You&rsquo;re all settled up
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {totals.map((t) => (
                <p
                  key={t.currency}
                  className={
                    totals.length > 1
                      ? 'text-2xl font-medium tracking-tight sm:text-3xl'
                      : 'text-3xl font-medium tracking-tight sm:text-4xl'
                  }
                >
                  {t.netCents > 0 ? 'You are owed ' : 'You owe '}
                  <NumberTicker
                    value={Math.abs(t.netCents)}
                    format={(cents) => formatMoney(Math.round(cents), t.currency)}
                  />
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
      <Link
        to="/activity"
        aria-label="View activity"
        className="absolute right-8 -bottom-5 flex size-12 items-center justify-center rounded-full bg-card text-card-foreground shadow-[0_4px_24px_rgba(0,0,0,0.08)]"
      >
        <ArrowUpRight className="size-5" aria-hidden="true" />
      </Link>
    </section>
  );
}

function GroupList({ sync }: { sync: SyncData }) {
  return (
    <div className="flex flex-col gap-3">
      {sync.groups.map((g, i) => {
        const mine = groupBalances(sync, g.id).filter(
          (b) => b.userId === sync.me.id && b.netCents !== 0,
        );
        return (
          <Link
            key={g.id}
            to={`/groups/${g.id}`}
            className="flex min-h-20 items-center gap-4 rounded-[28px] bg-card p-4 transition-colors animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards duration-300 hover:bg-secondary motion-reduce:animate-none"
            style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
          >
            <span
              className="flex size-12 shrink-0 items-center justify-center rounded-full bg-background text-2xl"
              aria-hidden="true"
            >
              {g.emoji}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{g.name}</span>
              <span className="text-sm text-muted-foreground">
                {g.memberIds.length === 1 ? 'Just you' : `${g.memberIds.length} members`}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              {mine.length === 0 ? (
                <span className="text-sm text-muted-foreground">settled up</span>
              ) : (
                mine.map((b) => (
                  <span key={b.currency} className="flex flex-col items-end">
                    <span className="text-[11px] text-muted-foreground">
                      {b.netCents > 0 ? 'you are owed' : 'you owe'}
                    </span>
                    <MoneyText
                      signed
                      cents={b.netCents}
                      currency={b.currency}
                      className="text-sm font-medium"
                    />
                  </span>
                ))
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function NoGroups({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty className="rounded-[28px] bg-card py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="rounded-full">
          <UsersRound />
        </EmptyMedia>
        <EmptyTitle>No groups yet</EmptyTitle>
        <EmptyDescription>
          Create a group for your flat, trip, or friends — or join one from an invite link.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button className="h-10 rounded-full px-5" onClick={onCreate}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          New group
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function NewGroupDialog({
  open,
  onOpenChange,
  defaultCurrency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCurrency: string;
}) {
  const navigate = useNavigate();
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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
          </DialogHeader>
          <GroupFormFields values={values} onChange={setValues} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="rounded-full"
              disabled={!values.name.trim() || createGroup.isPending || !online}
            >
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-8 pb-6">
      <Skeleton className="h-44 rounded-[40px]" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="h-20 rounded-[28px]" />
        <Skeleton className="h-20 rounded-[28px]" />
      </div>
    </div>
  );
}
