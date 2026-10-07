import { CloudAlert, TicketX } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';
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
import { useAcceptGuestClaim, useGuestClaimPreview, useSyncData } from '@/lib/queries';

/**
 * /claim/:token — someone tracked me as a guest in their group; accepting
 * moves the guest's expenses and balance onto my account.
 */
export default function Claim() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const preview = useGuestClaimPreview(token);
  const accept = useAcceptGuestClaim();
  const { data: sync } = useSyncData();

  const handleAccept = () => {
    accept.mutate(token, {
      onSuccess: ({ group }) => {
        toast(`Welcome to ${group.name}`);
        navigate(`/groups/${group.id}`, { replace: true });
      },
      onError: (err: Error) => toast.error(errorMessage(err)),
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

  // Only a definitive 404 means the link is truly gone (used, expired, or the
  // guest was removed). Network failures and 5xx must not read as "expired".
  const notFound = preview.error instanceof ApiError && preview.error.status === 404;
  if (notFound) {
    return (
      <div className="flex justify-center px-4 py-12">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketX />
            </EmptyMedia>
            <EmptyTitle>This link is invalid or expired</EmptyTitle>
            <EmptyDescription>
              It may already have been used. Ask for a fresh link — they expire after 7 days.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const claim = preview.data;
  if (!claim) {
    return (
      <div className="flex justify-center px-4 py-12">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&rsquo;t load this link</EmptyTitle>
            <EmptyDescription>
              {online
                ? 'Something went wrong — try again in a moment.'
                : "You're offline — reconnect to open this link."}
            </EmptyDescription>
          </EmptyHeader>
          <Button className="rounded-full px-6" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        </Empty>
      </div>
    );
  }

  const ownLink = sync !== undefined && claim.inviter.id === sync.me.id;

  return (
    <div className="flex justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl bg-card p-8 text-center shadow-[0_24px_48px_rgba(0,0,0,0.08)]">
        <span className="eyebrow">Claim your balance</span>
        <div className="flex size-24 items-center justify-center rounded-full bg-background text-5xl">
          <span aria-hidden="true">{claim.emoji}</span>
        </div>
        <h1 className="text-2xl">{claim.groupName}</h1>
        <p className="text-sm text-muted-foreground">
          {claim.inviter.name} has been tracking {claim.guest.name}&rsquo;s share here.{' '}
          <span className="font-medium text-foreground">
            {claim.guest.name}&rsquo;s balance in {claim.groupName} will become yours.
          </span>
        </p>
        {claim.alreadyMember ? (
          <p className="text-sm text-muted-foreground">
            You&rsquo;re already in this group — {claim.guest.name}&rsquo;s expenses will be
            combined with yours.
          </p>
        ) : null}
        {ownLink ? (
          <p className="text-sm text-muted-foreground">
            This is the link you shared — send it to {claim.guest.name} to accept.
          </p>
        ) : (
          <Button
            className="h-12 w-full rounded-full"
            disabled={!online || accept.isPending}
            onClick={handleAccept}
          >
            {accept.isPending ? <Spinner data-icon="inline-start" /> : null}
            I&rsquo;m {claim.guest.name} — accept
          </Button>
        )}
        {!online ? (
          <p className="text-sm text-muted-foreground">
            You're offline — accepting needs a connection.
          </p>
        ) : null}
      </div>
    </div>
  );
}
