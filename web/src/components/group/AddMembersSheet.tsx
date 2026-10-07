import { useState } from 'react';
import {
  EllipsisVertical,
  Link2,
  PencilLine,
  Share2,
  UserRoundMinus,
  UserRoundPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { GuestPill, UserAvatar } from '@/components/common/UserAvatar';
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { groupBalances } from '@/lib/balances';
import { claimShareText, GUEST_NAME_MAX, isGuest, normalizeGuestName } from '@/lib/guests';
import {
  useAddGroupMember,
  useAddGuest,
  useCreateGuestClaim,
  useCreateInvite,
  useRemoveGroupMember,
  useRemoveGuest,
  useRenameGuest,
  useSyncData,
} from '@/lib/queries';
import type { User } from '@/lib/types';

/** Friend lists longer than this get a filter field. */
const FILTER_AFTER = 6;

interface AddMembersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: number;
}

/**
 * One place to manage a group's people: current members (settled ones can be
 * removed — fixes mistaken adds), friends who join with a tap, guests for
 * people without Splitup (tracked by the group, claimable later), and the
 * invite link for people who will sign up.
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
  const addGuest = useAddGuest();
  const renameGuest = useRenameGuest();
  const removeGuest = useRemoveGuest();
  const createClaim = useCreateGuestClaim();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<User | null>(null);
  const [guestName, setGuestName] = useState('');
  const [renameTarget, setRenameTarget] = useState<User | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [guestOpen, setGuestOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const group = sync?.groups.find((g) => g.id === groupId);
  const userOf = (id: number): User =>
    sync?.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null };

  const members = group ? group.memberIds.map(userOf) : [];
  const candidates =
    sync && group
      ? sync.friendIds.filter((id) => !group.memberIds.includes(id)).map(userOf)
      : [];
  const needle = filter.trim().toLowerCase();
  const shownCandidates = needle
    ? candidates.filter(
        (u) => u.name.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle),
      )
    : candidates;
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
        onError: (err) => toast.error(errorMessage(err)),
        onSettled: () => setPendingId(null),
      },
    );
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const remove = isGuest(removeTarget) ? removeGuest : removeMember;
    remove.mutate(
      { groupId, userId: removeTarget.id },
      {
        onSuccess: () => toast.success(`${removeTarget.name} removed`),
        onError: (err) => toast.error(errorMessage(err)),
        onSettled: () => setRemoveTarget(null),
      },
    );
  };

  const submitGuest = (e: React.FormEvent) => {
    e.preventDefault();
    const name = normalizeGuestName(guestName);
    if (!name || addGuest.isPending) return;
    addGuest.mutate(
      { groupId, name },
      {
        onSuccess: () => {
          toast.success(`${name} added as a guest`);
          setGuestName('');
          setGuestOpen(false);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const openRename = (u: User) => {
    setRenameValue(u.name);
    setRenameTarget(u);
  };

  const submitRename = (e: React.FormEvent) => {
    e.preventDefault();
    const name = normalizeGuestName(renameValue);
    if (!renameTarget || !name || renameGuest.isPending) return;
    renameGuest.mutate(
      { groupId, userId: renameTarget.id, name },
      {
        onSuccess: () => {
          toast.success('Guest renamed');
          setRenameTarget(null);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  // A fresh one-time link for this guest: the OS share sheet where available,
  // clipboard otherwise.
  const shareClaim = (u: User) => {
    createClaim.mutate(
      { groupId, userId: u.id },
      {
        onSuccess: async ({ url }) => {
          const text = claimShareText(group?.name ?? 'our group', url);
          if (navigator.share) {
            try {
              await navigator.share({ text });
              return;
            } catch (err) {
              if (err instanceof Error && err.name === 'AbortError') return;
            }
          }
          try {
            await navigator.clipboard.writeText(text);
            toast.success(`Link for ${u.name} copied`);
          } catch {
            toast.message(`Send this to ${u.name}`, { description: text });
          }
        },
        onError: (err) => toast.error(errorMessage(err)),
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
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="text-xl">People</SheetTitle>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* The two ways in for people who aren't your friends yet, up top. */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="pill"
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
          <Button
            variant="outline"
            size="pill"
            aria-expanded={guestOpen}
            onClick={() => setGuestOpen((o) => !o)}
          >
            <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
            Add guest
          </Button>
        </div>
        {guestOpen ? (
          <form onSubmit={submitGuest} className="rounded-panel bg-muted/50 p-4">
            <Field>
              <FieldLabel htmlFor="guest-name">Guest&rsquo;s name</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="guest-name"
                  value={guestName}
                  maxLength={GUEST_NAME_MAX}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Name"
                  autoComplete="off"
                  autoFocus
                  className="h-11 flex-1 rounded-full px-4"
                />
                <Button
                  type="submit"
                  variant="outline"
                  className="h-11 rounded-full px-4"
                  disabled={!online || addGuest.isPending || normalizeGuestName(guestName) === null}
                >
                  {addGuest.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
                  )}
                  Add
                </Button>
              </div>
              <FieldDescription>
                For people without Splitup — you track their share. They can claim it later with a
                link.
              </FieldDescription>
            </Field>
          </form>
        ) : null}

        <section className="flex flex-col gap-1" aria-labelledby="people-members">
          <h3 id="people-members" className="eyebrow px-1">
            Members · {members.length}
          </h3>
          {members.map((u) => {
            const isMe = u.id === sync?.me.id;
            const isCreator = u.id === group?.createdBy;
            const hasBalance = unsettled.has(u.id);
            const guest = isGuest(u);
            const removable = !isMe && !isCreator && !hasBalance;
            return (
              <div key={u.id} className="flex min-h-12 items-center gap-3 rounded-2xl px-3">
                <UserAvatar user={u} size="sm" />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium break-words">{isMe ? 'You' : u.name}</span>
                  {guest ? <GuestPill /> : null}
                </span>
                {isCreator ? (
                  <span className="text-xs text-muted-foreground">creator</span>
                ) : hasBalance ? (
                  <span className="text-xs text-muted-foreground">has balance</span>
                ) : null}
                {guest ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 rounded-full"
                          disabled={!online}
                        />
                      }
                    >
                      <EllipsisVertical aria-hidden="true" />
                      <span className="sr-only">Options for {u.name}</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                      <DropdownMenuItem onClick={() => openRename(u)}>
                        <PencilLine aria-hidden="true" /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={createClaim.isPending}
                        onClick={() => shareClaim(u)}
                      >
                        <Share2 aria-hidden="true" /> Share claim link
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={!removable}
                        onClick={() => setRemoveTarget(u)}
                      >
                        <UserRoundMinus aria-hidden="true" />
                        {removable ? 'Remove' : 'Remove (settle first)'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : removable ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 rounded-full"
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
        </section>


        {candidates.length > 0 ? (
          <section className="flex flex-col gap-2" aria-labelledby="people-friends">
            <h3 id="people-friends" className="eyebrow px-1">
              Add friends
            </h3>
            {candidates.length > FILTER_AFTER ? (
              <Input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter friends"
                aria-label="Filter friends"
                autoComplete="off"
                className="h-11 rounded-full px-4"
              />
            ) : null}
            <div className="flex flex-col gap-1">
              {shownCandidates.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No friends match &ldquo;{filter.trim()}&rdquo;.
                </p>
              ) : null}
              {shownCandidates.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={!online || pendingId !== null}
                  onClick={() => add(u.id, u.name)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-full px-3 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  <UserAvatar user={u} size="sm" />
                  <span className="min-w-0 flex-1 font-medium break-words">{u.name}</span>
                  {pendingId === u.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <UserRoundPlus aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          </section>
        ) : null}
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
              {isGuest(removeTarget) ? (
                <>
                  They&rsquo;re fully settled, so no balances are affected. Past expenses keep
                  their name.
                </>
              ) : (
                <>
                  They&rsquo;ll lose access to this group. They&rsquo;re fully settled, so no
                  balances are affected — and they can be added back anytime.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMember.isPending || removeGuest.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!online || removeMember.isPending || removeGuest.isPending}
              onClick={confirmRemove}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <form onSubmit={submitRename} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Rename guest</DialogTitle>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="guest-rename">Name</FieldLabel>
              <Input
                id="guest-rename"
                value={renameValue}
                maxLength={GUEST_NAME_MAX}
                onChange={(e) => setRenameValue(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="rounded-full"
                disabled={
                  !online || renameGuest.isPending || normalizeGuestName(renameValue) === null
                }
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
