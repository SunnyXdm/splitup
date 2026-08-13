import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ChevronRight, HeartHandshake, Link2, UserRoundPlus } from 'lucide-react';
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
import { UserAvatar } from '@/components/common/UserAvatar';
import { useOnline } from '@/components/layout/OfflineBanner';
import { ApiError } from '@/lib/api';
import { friendBalance } from '@/lib/balances';
import { formatMoney } from '@/lib/money';
import { useAddFriend, useCreateFriendInvite, useSyncData } from '@/lib/queries';
import type { User } from '@/lib/types';

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
        <div className="flex flex-col divide-y divide-border/60 rounded-[28px] bg-card px-4">
          {friends.map((u) => {
            const entries = friendBalance(sync, u.id).filter((b) => b.netCents !== 0);
            return (
              <Link key={u.id} to={`/friends/${u.id}`} className="flex min-h-16 items-center gap-3 py-3">
                <UserAvatar user={u} />
                <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  {entries.length === 0 ? (
                    <span className="text-sm text-muted-foreground">settled up</span>
                  ) : (
                    entries.map((b) => (
                      <span
                        key={b.currency}
                        className={`text-sm font-medium tabular-nums ${b.netCents > 0 ? 'text-owed' : 'text-owing'}`}
                      >
                        {b.netCents > 0 ? 'owes you ' : 'you owe '}
                        {formatMoney(Math.abs(b.netCents), b.currency)}
                      </span>
                    ))
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      )}

      <AddFriendDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
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
      onError: (err) => toast.error(err.message),
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
      onSuccess: ({ user }) => {
        toast.success(`${user.name} is now your friend`);
        onOpenChange(false);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 404) {
          toast.error('No Splitup account with that email — invite them to a group instead');
        } else {
          toast.error(err.message);
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
              They need a Splitup account with this email address.
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
              Add friend
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
