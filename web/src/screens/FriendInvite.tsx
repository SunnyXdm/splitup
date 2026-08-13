import { CloudAlert, Link2, TicketX } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { UserAvatar } from '@/components/common/UserAvatar';
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
import { useAcceptFriendInvite, useFriendInvitePreview } from '@/lib/queries';

export default function FriendInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const preview = useFriendInvitePreview(token);
  const accept = useAcceptFriendInvite();

  const handleAccept = () => {
    accept.mutate(token, {
      onSuccess: ({ user }) => {
        toast(`You and ${user.name} are now friends`);
        navigate(`/friends/${user.id}`);
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

  if (invite.isSelf) {
    const copyLink = async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        toast('Invite link copied');
      } catch {
        toast.message('Invite link', { description: window.location.href });
      }
    };
    return (
      <div className="flex justify-center px-4 py-12">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.08)]">
          <span className="eyebrow">Friend invite</span>
          <UserAvatar user={invite.inviter} size="lg" className="size-24 text-2xl" />
          <h1 className="text-2xl">This is your invite link</h1>
          <p className="text-sm text-muted-foreground">
            Send it to someone else — when they open it and sign in, you become friends.
          </p>
          <Button className="h-12 w-full rounded-full" onClick={copyLink}>
            <Link2 data-icon="inline-start" aria-hidden="true" />
            Copy link
          </Button>
        </div>
      </div>
    );
  }

  if (invite.alreadyFriends) {
    return (
      <div className="flex justify-center px-4 py-12">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.08)]">
          <span className="eyebrow">Friend invite</span>
          <UserAvatar user={invite.inviter} size="lg" className="size-24 text-2xl" />
          <h1 className="text-2xl">{invite.inviter.name}</h1>
          <p className="text-sm text-muted-foreground">You&rsquo;re already friends.</p>
          <Button
            className="h-12 w-full rounded-full"
            onClick={() => navigate(`/friends/${invite.inviter.id}`)}
          >
            View friend
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.08)]">
        <span className="eyebrow">Friend invite</span>
        <UserAvatar user={invite.inviter} size="lg" className="size-24 text-2xl" />
        <h1 className="text-2xl">{invite.inviter.name}</h1>
        <p className="text-sm text-muted-foreground">
          wants to split expenses with you on Splitup.
        </p>
        <Button
          className="h-12 w-full rounded-full"
          disabled={!online || accept.isPending}
          onClick={handleAccept}
        >
          {accept.isPending ? <Spinner data-icon="inline-start" /> : null}
          Add friend
        </Button>
        {!online ? (
          <p className="text-sm text-muted-foreground">
            You're offline — accepting needs a connection.
          </p>
        ) : null}
      </div>
    </div>
  );
}
