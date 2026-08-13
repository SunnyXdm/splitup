import { CloudAlert, TicketX } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useInvitePreview, useJoinInvite } from '@/lib/queries';

export default function Join() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const preview = useInvitePreview(token);
  const joinInvite = useJoinInvite();

  const handleJoin = () => {
    joinInvite.mutate(token, {
      onSuccess: (joinedGroup) => {
        toast(`Welcome to ${joinedGroup.name}`);
        navigate(`/groups/${joinedGroup.id}`);
      },
      onError: (err: Error) => toast.error(err.message),
    });
  };

  if (preview.isPending) {
    return (
      <div className="flex justify-center px-4 py-12">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8">
          <Skeleton className="size-24 rounded-full" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-12 w-full rounded-full" />
        </div>
      </div>
    );
  }

  // Only a definitive 404 means the invite is truly gone. Network failures,
  // 401s, and 5xx must NOT masquerade as "expired".
  const notFound = preview.error instanceof ApiError && preview.error.status === 404;
  if (notFound) {
    return (
      <div className="flex justify-center px-4 py-12">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketX />
            </EmptyMedia>
            <EmptyTitle>This invite link is invalid or expired</EmptyTitle>
            <EmptyDescription>
              Ask for a fresh link — invites expire after 7 days.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const invite = preview.data;
  if (!invite) {
    return (
      <div className="flex justify-center px-4 py-12">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&rsquo;t load this invite</EmptyTitle>
            <EmptyDescription>
              {online
                ? 'Something went wrong — try again in a moment.'
                : "You're offline — reconnect to view this invite."}
            </EmptyDescription>
          </EmptyHeader>
          <Button className="rounded-full px-6" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        </Empty>
      </div>
    );
  }

  const names =
    invite.memberNames.slice(0, 5).join(', ') +
    (invite.memberNames.length > 5 ? ` & ${invite.memberNames.length - 5} more` : '');

  return (
    <div className="flex justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.08)]">
        <span className="eyebrow">Group invite</span>
        <div className="flex size-24 items-center justify-center rounded-full bg-background text-5xl">
          <span aria-hidden="true">{invite.emoji}</span>
        </div>
        <h1 className="text-2xl">{invite.groupName}</h1>
        <p className="text-sm text-muted-foreground">
          {invite.alreadyMember
            ? 'You are already a member of this group.'
            : `${invite.memberCount} ${invite.memberCount === 1 ? 'member' : 'members'} — ${names}`}
        </p>
        {invite.alreadyMember ? (
          <Button
            className="h-12 w-full rounded-full"
            onClick={() => navigate(`/groups/${invite.groupId}`)}
          >
            Open group
          </Button>
        ) : (
          <Button
            className="h-12 w-full rounded-full"
            disabled={!online || joinInvite.isPending}
            onClick={handleJoin}
          >
            {joinInvite.isPending ? <Spinner data-icon="inline-start" /> : null}
            Join group
          </Button>
        )}
        {!online ? (
          <p className="text-sm text-muted-foreground">
            You're offline — joining needs a connection.
          </p>
        ) : null}
      </div>
    </div>
  );
}
