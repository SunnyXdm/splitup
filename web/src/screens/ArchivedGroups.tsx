import { Link } from 'react-router';
import { Archive, ArchiveRestore } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
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
        <Skeleton className="h-11 w-40 rounded-full" />
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-20 rounded-card" />
      </div>
    );
  }

  const groups = archivedGroups(sync.groups);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        eyebrow="Groups"
        title="Archived"
        description="Hidden from your Home only. Balances here still count toward your totals, and new activity that involves you brings a group back."
      />

      {groups.length === 0 ? (
        <Empty className="rounded-card bg-card py-12">
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
              <div key={g.id} className="flex flex-col gap-3 rounded-card bg-card p-4">
                <Link
                  to={`/groups/${g.id}`}
                  className="-m-2 flex items-center gap-4 rounded-panel p-2 transition-colors hover:bg-secondary"
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
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {open.length > 0 ? 'You still have a balance here' : null}
                  </span>
                  <Button
                    variant="outline"
                    size="pill"
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
