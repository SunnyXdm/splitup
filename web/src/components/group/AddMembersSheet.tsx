import { useState } from 'react';
import { Link2, UserRoundMinus, UserRoundPlus } from 'lucide-react';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useOnline } from '@/components/layout/OfflineBanner';
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { groupBalances } from '@/lib/balances';
import {
  useAddGroupMember,
  useCreateInvite,
  useRemoveGroupMember,
  useSyncData,
} from '@/lib/queries';
import type { User } from '@/lib/types';

interface AddMembersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: number;
}

/**
 * One place to manage a group's people: current members (settled ones can be
 * removed — fixes mistaken adds), friends who join with a tap, and the invite
 * link for people not on Splitup yet.
 */
export default function AddMembersSheet({ open, onOpenChange, groupId }: AddMembersSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full max-w-xl rounded-t-[28px]"
      >
        <SheetBody groupId={groupId} />
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({ groupId }: { groupId: number }) {
  const { data: sync } = useSyncData();
  const online = useOnline();
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const createInvite = useCreateInvite();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<User | null>(null);

  const group = sync?.groups.find((g) => g.id === groupId);
  const userOf = (id: number): User =>
    sync?.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null };

  const members = group ? group.memberIds.map(userOf) : [];
  const candidates =
    sync && group
      ? sync.friendIds.filter((id) => !group.memberIds.includes(id)).map(userOf)
      : [];
  // A member is removable only when settled in every currency (server enforces
  // the same rule) — and never the creator or yourself (use Leave for that).
  const unsettled = new Set(
    sync && group ? groupBalances(sync, group.id).filter((b) => b.netCents !== 0).map((b) => b.userId) : [],
  );

  const add = (userId: number, name: string) => {
    if (addMember.isPending) return;
    setPendingId(userId);
    addMember.mutate(
      { groupId, userId },
      {
        onSuccess: () => toast.success(`${name} added to ${group?.name ?? 'the group'}`),
        onError: (err) => toast.error(err.message),
        onSettled: () => setPendingId(null),
      },
    );
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    removeMember.mutate(
      { groupId, userId: removeTarget.id },
      {
        onSuccess: () => toast.success(`${removeTarget.name} removed`),
        onError: (err) => toast.error(err.message),
        onSettled: () => setRemoveTarget(null),
      },
    );
  };

  const copyInvite = () => {
    createInvite.mutate(groupId, {
      onSuccess: async ({ url }) => {
        try {
          await navigator.clipboard.writeText(url);
          toast.success('Invite link copied');
        } catch {
          toast.message('Copy this invite link', { description: url });
        }
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="text-xl">People</SheetTitle>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Members</span>
          {members.map((u) => {
            const isMe = u.id === sync?.me.id;
            const isCreator = u.id === group?.createdBy;
            const hasBalance = unsettled.has(u.id);
            const removable = !isMe && !isCreator && !hasBalance;
            return (
              <div key={u.id} className="flex min-h-12 items-center gap-3 rounded-2xl px-3">
                <UserAvatar user={u} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {isMe ? 'You' : u.name}
                </span>
                {isCreator ? (
                  <span className="text-xs text-muted-foreground">creator</span>
                ) : hasBalance ? (
                  <span className="text-xs text-muted-foreground">has balance</span>
                ) : null}
                {removable ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-full"
                    aria-label={`Remove ${u.name}`}
                    disabled={!online || removeMember.isPending}
                    onClick={() => setRemoveTarget(u)}
                  >
                    <UserRoundMinus aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>

        {candidates.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Add friends</span>
            {candidates.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={!online || pendingId !== null}
                onClick={() => add(u.id, u.name)}
                className="flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <UserAvatar user={u} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                {pendingId === u.id ? (
                  <Spinner className="size-4" />
                ) : (
                  <UserRoundPlus aria-hidden="true" className="size-4 text-muted-foreground" />
                )}
              </button>
            ))}
          </div>
        ) : null}

        <Button
          variant="outline"
          className="h-11 rounded-full"
          disabled={!online || createInvite.isPending}
          onClick={copyInvite}
        >
          {createInvite.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Link2 data-icon="inline-start" aria-hidden="true" />
          )}
          Copy invite link
        </Button>
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They&rsquo;ll lose access to this group. They&rsquo;re fully settled, so no
              balances are affected — and they can be added back anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMember.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!online || removeMember.isPending}
              onClick={confirmRemove}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
