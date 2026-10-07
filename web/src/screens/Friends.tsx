import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  HeartHandshake,
  Link2,
  Search,
  UserRoundPlus,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
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
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { FormSheet } from '@/components/common/FormSheet';
import { MoneyText } from '@/components/common/MoneyText';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useOnline } from '@/components/layout/OfflineBanner';
import { ApiError, errorMessage } from '@/lib/api';
import { myPersonBalances, orderByCurrency, type CurrencyAmount } from '@/lib/balances';
import { isGuest } from '@/lib/guests';
import {
  useAcceptFriendRequest,
  useAddFriend,
  useCreateFriendInvite,
  useDeleteFriendRequest,
  useSyncData,
} from '@/lib/queries';
import { normalizeText } from '@/lib/search';
import type { FriendRequests, User } from '@/lib/types';
import { useParamState } from '@/lib/use-history-filters';
import { EntranceScope } from '@/components/common/Entrance';
import { useEnterItem } from '@/lib/motion';
import { cn } from '@/lib/utils';

type Show = 'all' | 'owed' | 'owe';
const SHOWS = ['all', 'owed', 'owe'] as const;

const SHOW_LABELS: Record<Show, string> = { all: 'All', owed: 'Owe you', owe: 'You owe' };

interface PersonRow {
  user: User;
  /** Open balances with me, default currency first; + = they owe me. */
  balances: CurrencyAmount[];
}

/**
 * Friends: requests, then everyone with their balance. ?show=owed|owe (the
 * Home hero's two totals link here) narrows the list to one direction,
 * largest first, and also lists people from shared groups who aren't
 * friends — so the list adds up to the hero's total.
 */
export default function Friends() {
  const { data: sync } = useSyncData();
  const [addOpen, setAddOpen] = useState(false);
  const [show, setShow] = useParamState<Show>('show', SHOWS, 'all');
  const [query, setQuery] = useState('');

  if (!sync) return <FriendsSkeleton />;

  const primary = sync.me.defaultCurrency;
  const byUser = new Map<number, CurrencyAmount[]>();
  for (const p of myPersonBalances(sync)) {
    const list = byUser.get(p.userId) ?? [];
    list.push({ currency: p.currency, netCents: p.netCents });
    byUser.set(p.userId, list);
  }
  const rowFor = (user: User): PersonRow => ({
    user,
    balances: orderByCurrency(byUser.get(user.id) ?? [], primary),
  });
  const friendIds = new Set(sync.friendIds);
  const friends = sync.friendIds
    .map((fid) => sync.users.find((u) => u.id === fid))
    .filter((u): u is User => u !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(rowFor);

  const sign = show === 'owed' ? 1 : -1;
  const inDirection = (r: PersonRow) => r.balances.some((b) => Math.sign(b.netCents) === sign);
  // Largest first within the default currency, then other currencies (stable).
  const byAmount = (a: PersonRow, b: PersonRow) => {
    const lead = (r: PersonRow) => {
      const own = r.balances.find((x) => Math.sign(x.netCents) === sign);
      return own?.currency === primary ? Math.abs(own.netCents) : -1;
    };
    return lead(b) - lead(a) || a.user.name.localeCompare(b.user.name);
  };
  const others =
    show === 'all'
      ? []
      : [...byUser.keys()]
          .filter((id) => !friendIds.has(id) && id !== sync.me.id)
          .map((id) => sync.users.find((u) => u.id === id))
          .filter((u): u is User => u !== undefined)
          .map(rowFor)
          .filter(inDirection)
          .sort(byAmount);

  const needle = normalizeText(query);
  const matches = (r: PersonRow) =>
    needle === '' ||
    normalizeText(r.user.name).includes(needle) ||
    normalizeText(r.user.email ?? '').includes(needle);
  // A direction view lists only the amounts in that direction.
  const onlyDirection = (r: PersonRow): PersonRow =>
    show === 'all'
      ? r
      : { ...r, balances: r.balances.filter((b) => Math.sign(b.netCents) === sign) };
  const listed = (show === 'all' ? friends : friends.filter(inDirection).sort(byAmount))
    .filter(matches)
    .map(onlyDirection);
  const otherListed = others.filter(matches).map(onlyDirection);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title="Friends"
        actions={
          friends.length > 0 ? (
            <Button variant="outline" size="pill" onClick={() => setAddOpen(true)}>
              <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
              Add friend
            </Button>
          ) : null
        }
      />

      <IncomingRequests requests={sync.friendRequests} />

      {friends.length === 0 ? (
        <Empty className="rounded-card bg-card py-12">
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
            <Button size="cta" onClick={() => setAddOpen(true)}>
              <UserRoundPlus data-icon="inline-start" aria-hidden="true" />
              Add friend
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <section aria-label="Your friends" className="flex flex-col gap-3">
          {friends.length > 3 ? <FriendSearch value={query} onChange={setQuery} /> : null}
          <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
            {SHOWS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={show === s}
                onClick={() => setShow(s)}
                className={cn(
                  'hit-area relative h-9 rounded-full border border-border bg-card px-4 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-focus-ring',
                  show === s
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {SHOW_LABELS[s]}
              </button>
            ))}
          </div>

          {listed.length === 0 ? (
            <p className="rounded-card bg-card px-6 py-8 text-center text-muted-foreground">
              {needle !== ''
                ? `No friends match “${query.trim()}”.`
                : show === 'owed'
                  ? 'No friends owe you right now.'
                  : 'You don’t owe any friends right now.'}
            </p>
          ) : (
            <FriendList>
              {listed.map((r, i) => (
                <FriendRow key={r.user.id} index={i} to={`/friends/${r.user.id}`} row={r} />
              ))}
            </FriendList>
          )}

          {otherListed.length > 0 ? (
            <div className="flex flex-col gap-2 pt-3">
              <h2 className="px-1 text-sm font-medium text-muted-foreground">
                Others in your groups
              </h2>
              <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
                {otherListed.map((r) => (
                  <div key={r.user.id} className="flex min-h-16 items-center gap-3 py-3">
                    <PersonCells row={r} note={isGuest(r.user) ? 'Guest' : 'Not a friend yet'} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      )}

      <SentRequests requests={sync.friendRequests} />

      <AddFriendSheet open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function FriendSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Label htmlFor="friend-search" className="sr-only">
        Search friends
      </Label>
      <Search
        className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id="friend-search"
        type="search"
        autoComplete="off"
        enterKeyHint="search"
        value={value}
        placeholder="Search friends"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.preventDefault();
            onChange('');
          }
        }}
        className="h-12 rounded-full border-transparent bg-card pr-4 pl-11 text-base shadow-level-1 md:text-sm dark:bg-card [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/** The friends card; its rows stagger in on the screen's first visit. */
function FriendList({ children }: { children: ReactNode }) {
  return (
    <EntranceScope id="friends">
      <div className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
        {children}
      </div>
    </EntranceScope>
  );
}

function FriendRow({ index, to, row }: { index: number; to: string; row: PersonRow }) {
  const enter = useEnterItem(index);
  return (
    <Link
      to={to}
      className={cn('flex min-h-16 items-center gap-3 py-3', enter.className)}
      style={enter.style}
    >
      <PersonCells row={row} />
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

/** Avatar · name (+ note) · balance per currency: amount over its direction words. */
function PersonCells({ row, note }: { row: PersonRow; note?: string }) {
  return (
    <>
      <UserAvatar user={row.user} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 font-medium break-words">{row.user.name}</span>
        {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {row.balances.length === 0 ? (
          <span className="text-sm text-muted-foreground">settled up</span>
        ) : (
          row.balances.map((b) => (
            <span key={b.currency} className="flex flex-col items-end leading-tight">
              <MoneyText
                signed
                animate
                cents={b.netCents}
                currency={b.currency}
                className="font-medium"
              />
              <span className="text-sm text-muted-foreground">
                {b.netCents > 0 ? 'owes you' : 'you owe'}
              </span>
            </span>
          ))
        )}
      </span>
    </>
  );
}

export function AddFriendSheet({
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

  const submit = () => {
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
    <FormSheet
      open={open}
      onOpenChange={handleOpenChange}
      title="Add a friend"
      description={
        <>
          We&rsquo;ll send them a friend request — they&rsquo;ll see it next time they open
          Splitup.
        </>
      }
      onSubmit={submit}
      submitLabel="Send request"
      pending={addFriend.isPending}
      submitDisabled={!email.trim() || addFriend.isPending || !online}
    >
      <div className="flex flex-col gap-4">
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
          size="pill"
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
      </div>
    </FormSheet>
  );
}

function useRequestActions() {
  const accept = useAcceptFriendRequest();
  const remove = useDeleteFriendRequest();
  const busy = (id: number) =>
    (accept.isPending && accept.variables === id) || (remove.isPending && remove.variables === id);
  return { accept, remove, busy };
}

/** Incoming requests: who it is (name + full email), then Accept / Ignore. */
function IncomingRequests({ requests }: { requests: FriendRequests | undefined }) {
  const online = useOnline();
  const { accept, remove, busy } = useRequestActions();
  const incoming = requests?.incoming ?? [];
  if (incoming.length === 0) return null;

  return (
    <section aria-labelledby="friend-requests-title" className="flex flex-col gap-2">
      <h2 id="friend-requests-title" className="px-1 text-sm font-medium text-muted-foreground">
        Friend requests ({incoming.length})
      </h2>
      <ul className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4">
        {incoming.map((r) => (
          <li key={r.id} className="flex flex-col gap-3 py-4">
            <div className="flex items-start gap-3">
              <UserAvatar user={r.user} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">{r.user.name}</span>
                {r.user.email ? (
                  <span className="text-sm break-all text-muted-foreground">{r.user.email}</span>
                ) : null}
                <span className="text-sm text-muted-foreground">wants to be your friend</span>
              </div>
            </div>
            <div className="flex gap-2 pl-12">
              <Button
                size="pill"
                disabled={!online || busy(r.id)}
                aria-label={`Accept ${r.user.name}`}
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
                {busy(r.id) && accept.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Check data-icon="inline-start" aria-hidden="true" />
                )}
                Accept
              </Button>
              <Button
                variant="outline"
                size="pill"
                disabled={!online || busy(r.id)}
                aria-label={`Ignore ${r.user.name}`}
                onClick={() =>
                  remove.mutate(r.id, {
                    onSuccess: () => toast('Request ignored'),
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              >
                Ignore
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Requests I sent that are still pending, folded behind a count. */
function SentRequests({ requests }: { requests: FriendRequests | undefined }) {
  const online = useOnline();
  const { remove, busy } = useRequestActions();
  const [open, setOpen] = useState(false);
  const outgoing = requests?.outgoing ?? [];
  if (outgoing.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="sent-requests"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 items-center gap-3 rounded-full px-4 text-muted-foreground transition-colors outline-none hover:bg-card hover:text-foreground focus-visible:ring-3 focus-visible:ring-focus-ring"
      >
        <Clock className="size-5 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Sent requests ({outgoing.length})</span>
        <ChevronDown
          className={cn('size-5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          id="sent-requests"
          className="flex flex-col divide-y divide-border/60 rounded-card bg-card px-4"
        >
          {outgoing.map((r) => (
            <li key={r.id} className="flex min-h-16 items-center gap-3 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-all">{r.email}</span>
                <span className="text-sm text-muted-foreground">Waiting for them to accept</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full px-3"
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
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function FriendsSkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-6">
      <Skeleton className="h-11 w-40 rounded-full" />
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}
