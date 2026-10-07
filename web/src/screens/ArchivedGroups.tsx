import { Link } from 'react-router';
import { Archive, ArchiveRestore, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { MyGroupBalance } from '@/components/group/MyGroupBalance';
import { useOnline } from '@/components/layout/OfflineBanner';
import { archivedGroups, myOpenGroupBalances } from '@/lib/archive';
import { useSyncData } from '@/lib/queries';
import { useArchiveToggle } from '@/lib/use-archive-group';

/** /groups/archived — groups I hid from Home. Only mine; other members still see them. */
export default function ArchivedGroups() {
  const { data: sync } = useSyncData();
  const online = useOnline();
  const toggleArchive = useArchiveToggle();

  if (!sync) {
    return (
      <div className="flex flex-col gap-4 pb-6">
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="h-20 rounded-[28px]" />
        <Skeleton className="h-20 rounded-[28px]" />
      </div>
    );
  }

  const groups = archivedGroups(sync.groups);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <header className="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon-lg"
          className="size-10 rounded-full"
          render={<Link to="/" aria-label="Back to Home" />}
          nativeButton={false}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow">Groups</span>
          <h1 className="truncate text-2xl font-medium tracking-tight">Archived</h1>
        </div>
      </header>
      <p className="-mt-2 text-sm text-muted-foreground">
        Hidden from your Home only. Balances here still count toward your totals, and new
        activity that involves you brings a group back.
      </p>

      {groups.length === 0 ? (
        <Empty className="rounded-[28px] bg-card py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <Archive />
            </EmptyMedia>
            <EmptyTitle>Nothing archived</EmptyTitle>
            <EmptyDescription>
              Archive a finished trip from its menu to tidy up your Home.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const open = myOpenGroupBalances(sync, g.id);
            return (
              <div key={g.id} className="flex flex-col gap-3 rounded-[28px] bg-card p-4">
                <Link
                  to={`/groups/${g.id}`}
                  className="-m-2 flex items-center gap-4 rounded-[22px] p-2 transition-colors hover:bg-secondary"
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
                  <MyGroupBalance balances={open} />
                </Link>
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {open.length > 0 ? 'You still have a balance here' : null}
                  </span>
                  <Button
                    variant="outline"
                    className="h-9 rounded-full px-4"
                    disabled={!online}
                    onClick={() => toggleArchive(g, false)}
                  >
                    <ArchiveRestore data-icon="inline-start" aria-hidden="true" />
                    Unarchive
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
