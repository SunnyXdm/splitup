import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Check, ChevronRight, Clock, HeartHandshake, Link2, UserRoundPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { AnimatedMoney } from '@/components/common/MoneyText';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useOnline } from '@/components/layout/OfflineBanner';
import { ApiError, errorMessage } from '@/lib/api';
import { friendBalance } from '@/lib/balances';
import {
  useAcceptFriendRequest,
  useAddFriend,
  useCreateFriendInvite,
  useDeleteFriendRequest,
  useSyncData,
} from '@/lib/queries';
import type { FriendRequests, User } from '@/lib/types';
import { EntranceScope } from '@/components/common/Entrance';
import { useEnterItem } from '@/lib/motion';
import { cn } from '@/lib/utils';

export default function Friends() {
  const { data: sync } = useSyncData();
  const [addOpen, setAddOpen] = useState(false);

  if (!sync) return <FriendsSkeleton />;

  const friends = sync.friendIds
    .map((fid) => sync.users.find((u) => u.id === fid))
    .filter((u): u is User => u !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-4 pb-6">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Friends</span>
        {friends.length > 0 && (
          <Button
            variant="outline"
            className="h-10 rounded-full px-4"
            onClick={() => setAddOpen(true)}
          >
            <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
            Add friend
          </Button>
        )}
      </div>

      <FriendRequestsSection requests={sync.friendRequests} />

      {friends.length === 0 ? (
        <Empty className="rounded-[28px] bg-card py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full">
              <HeartHandshake />
            </EmptyMedia>
            <EmptyTitle>No friends yet</EmptyTitle>
            <EmptyDescription>
              Friends appear automatically when you share a group — or add one by email.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button className="h-10 rounded-full px-5" onClick={() => setAddOpen(true)}>
              <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
              Add friend
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <FriendList>
          {friends.map((u, i) => {
            const entries = friendBalance(sync, u.id).filter((b) => b.netCents !== 0);
            return (
              <FriendRow key={u.id} index={i} to={`/friends/${u.id}`}>
                <UserAvatar user={u} />
                <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  {entries.length === 0 ? (
                    <span className="text-sm text-muted-foreground">settled up</span>
                  ) : (
                    entries.map((b) => (
                      <span
                        key={b.currency}
                        className={`text-sm font-medium tabular-nums transition-colors duration-(--dur-base) ${b.netCents > 0 ? 'text-owed' : 'text-owing'}`}
                      >
                        {b.netCents > 0 ? 'owes you ' : 'you owe '}
                        <AnimatedMoney cents={b.netCents} currency={b.currency} />
                      </span>
                    ))
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </FriendRow>
            );
          })}
        </FriendList>
      )}

      <AddFriendDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/** The friends card; its rows stagger in on the screen's first visit. */
function FriendList({ children }: { children: ReactNode }) {
  return (
    <EntranceScope id="friends">
      <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
        {children}
      </div>
    </EntranceScope>
  );
}

function FriendRow({ index, to, children }: { index: number; to: string; children: ReactNode }) {
  const enter = useEnterItem(index);
  return (
    <Link
      to={to}
      className={cn('flex min-h-16 items-center gap-3 py-3', enter.className)}
      style={enter.style}
    >
      {children}
    </Link>
  );
}

function AddFriendDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const online = useOnline();
  const addFriend = useAddFriend();
  const createInvite = useCreateFriendInvite();
  const [email, setEmail] = useState('');

  const copyInviteLink = () => {
    createInvite.mutate(undefined, {
      onSuccess: async ({ url }) => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Invite link copied');
        } catch {
          toast.message('Invite link', { description: url });
        }
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const handleOpenChange = (next: boolean) => {
    if (next) setEmail('');
    onOpenChange(next);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || addFriend.isPending) return;
    addFriend.mutate(value, {
      onSuccess: (result) => {
        if (result.status === 'friends') {
          toast.success(`${result.user.name} is now your friend`);
        } else {
          // Same answer whether or not the email has an account (no oracle).
          toast.success("Request sent — they'll see it next time they open Splitup");
        }
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 400) {
          toast.error("That's your own email — enter a friend's instead.");
        } else if (err instanceof ApiError && err.status === 429) {
          toast.error('Too many friend requests — try again in a while.');
        } else {
          toast.error(errorMessage(err));
        }
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a friend</DialogTitle>
            <DialogDescription>
              We&rsquo;ll send them a friend request — they&rsquo;ll see it next time they open
              Splitup.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="friend-email">Email</FieldLabel>
              <Input
                id="friend-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="friend@example.com"
                autoComplete="email"
              />
            </Field>
          </FieldGroup>
          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-full"
            disabled={!online || createInvite.isPending}
            onClick={copyInviteLink}
          >
            {createInvite.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Link2 data-icon="inline-start" aria-hidden="true" />
            )}
            Copy invite link
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Anyone who opens your link and signs in becomes your friend. Links expire in 7 days.
          </p>
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
              disabled={!email.trim() || addFriend.isPending || !online}
            >
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pending requests: incoming (Accept / Decline) and my outgoing (Cancel). */
function FriendRequestsSection({ requests }: { requests: FriendRequests | undefined }) {
  const online = useOnline();
  const accept = useAcceptFriendRequest();
  const remove = useDeleteFriendRequest();
  const incoming = requests?.incoming ?? [];
  const outgoing = requests?.outgoing ?? [];
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const busy = (id: number) =>
    (accept.isPending && accept.variables === id) || (remove.isPending && remove.variables === id);

  return (
    <section className="flex flex-col gap-3" aria-label="Friend requests">
      {incoming.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="px-1 text-sm font-medium text-muted-foreground">
            Friend requests
          </span>
          <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
            {incoming.map((r) => (
              <div key={r.id} className="flex min-h-16 items-center gap-3 py-3">
                <UserAvatar user={r.user} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{r.user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    wants to be your friend
                  </span>
                </span>
                <Button
                  size="icon-lg"
                  variant="outline"
                  className="size-10 rounded-full"
                  aria-label={`Decline ${r.user.name}`}
                  disabled={!online || busy(r.id)}
                  onClick={() =>
                    remove.mutate(r.id, { onError: (err) => toast.error(errorMessage(err)) })
                  }
                >
                  <X aria-hidden="true" />
                </Button>
                <Button
                  size="icon-lg"
                  className="size-10 rounded-full"
                  aria-label={`Accept ${r.user.name}`}
                  disabled={!online || busy(r.id)}
                  onClick={() =>
                    accept.mutate(r.id, {
                      onSuccess: ({ user }) => toast.success(`${user.name} is now your friend`),
                      onError: (err) =>
                        toast.error(
                          err instanceof ApiError && err.status === 404
                            ? 'That request is no longer available.'
                            : errorMessage(err),
                        ),
                    })
                  }
                >
                  {busy(r.id) && accept.isPending ? <Spinner /> : <Check aria-hidden="true" />}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {outgoing.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="px-1 text-sm font-medium text-muted-foreground">Sent requests</span>
          <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
            {outgoing.map((r) => (
              <div key={r.id} className="flex min-h-14 items-center gap-3 py-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
                  <Clock className="size-4" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{r.email}</span>
                  <span className="text-xs text-muted-foreground">Pending</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  aria-label={`Cancel request to ${r.email}`}
                  disabled={!online || busy(r.id)}
                  onClick={() =>
                    remove.mutate(r.id, {
                      onSuccess: () => toast('Request cancelled'),
                      onError: (err) => toast.error(errorMessage(err)),
                    })
                  }
                >
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FriendsSkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-6">
      <Skeleton className="h-4 w-24 rounded-full" />
      <Skeleton className="h-64 rounded-[28px]" />
    </div>
  );
}
