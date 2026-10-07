import { useRef, useState } from 'react';
import { ArrowLeft, ArrowLeftRight, ChevronDown, ChevronRight } from 'lucide-react';
import { MoneyText } from '@/components/common/MoneyText';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatDateSafe } from '@/lib/dates';
import {
  explainDirect,
  explainFriend,
  explainGroup,
  type GroupExplanation,
  type MemberTotals,
} from '@/lib/explain';
import { formatMoney } from '@/lib/money';
import { useSyncData } from '@/lib/queries';
import type { SyncData } from '@/lib/types';
import { useHistoryDismiss } from '@/lib/use-history-dismiss';
import { cn } from '@/lib/utils';

/**
 * What to explain:
 * - friend: my balance with a friend in one currency, drillable per scope;
 * - group: one group's routing as seen from `focusId` — towards `otherId`
 *   when set (any member, friend or not), else focusId's own group net.
 */
export type ExplainTarget =
  | { kind: 'friend'; friendId: number; currency: string }
  | {
      kind: 'group';
      groupId: number;
      currency: string;
      focusId: number;
      otherId: number | null;
    };

export default function ExplainBalanceSheet({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ExplainTarget | null;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={popupRef}
        // Read-only sheet: keyboard users land on the first control as usual;
        // pointer users get the popup itself, not a focus ring on row one.
        initialFocus={(type) => (type === 'keyboard' ? true : popupRef.current)}
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-2 rounded-t-[28px] outline-none"
      >
        {/* Mounted only while open, so drill-down state resets between uses. */}
        {target ? <ExplainBody target={target} /> : null}
      </SheetContent>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- helpers */

interface Names {
  meId: number;
  /** "You" for me, else the person's name. */
  subject: (id: number) => string;
  /** "you" for me, else the person's name. */
  object: (id: number) => string;
}

function namesFor(sync: SyncData): Names {
  const byId = new Map(sync.users.map((u) => [u.id, u.name]));
  const meId = sync.me.id;
  const name = (id: number) => byId.get(id) ?? 'Former member';
  return {
    meId,
    subject: (id) => (id === meId ? 'You' : name(id)),
    object: (id) => (id === meId ? 'you' : name(id)),
  };
}

/** "+₹50" / "−₹50" / "₹0", colored owed/owing. */
function Signed({
  cents,
  currency,
  className,
}: {
  cents: number;
  currency: string;
  className?: string;
}) {
  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)}>
      <span className={cents > 0 ? 'text-owed' : cents < 0 ? 'text-owing' : undefined}>
        {cents > 0 ? '+' : cents < 0 ? '−' : ''}
      </span>
      <MoneyText signed cents={cents} currency={currency} />
    </span>
  );
}

function asOf(sync: SyncData): string {
  return `As of ${formatDateSafe(sync.syncedAt, 'MMM d, h:mm a', 'your last sync')}`;
}

/** "Why does Alice owe you ₹5?" — `cents` + means `other` owes `focus`. */
function whyTitle(names: Names, focusId: number, otherId: number, cents: number, currency: string) {
  const amount = formatMoney(Math.abs(cents), currency);
  const [debtor, creditor] = cents > 0 ? [otherId, focusId] : [focusId, otherId];
  return debtor === names.meId
    ? `Why do you owe ${names.object(creditor)} ${amount}?`
    : `Why does ${names.subject(debtor)} owe ${names.object(creditor)} ${amount}?`;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 w-fit rounded-full text-muted-foreground"
      onClick={onClick}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      Back
    </Button>
  );
}

function ScopeBadge({ emoji }: { emoji: string | null }) {
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-xl"
      aria-hidden="true"
    >
      {emoji ?? <ArrowLeftRight className="size-4 text-foreground/70" />}
    </span>
  );
}

function TotalRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 py-3 text-sm font-medium">
      <span>{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- body */

type Drill = { kind: 'group'; groupId: number } | { kind: 'direct' } | null;

function ExplainBody({ target }: { target: ExplainTarget }) {
  const { data: sync } = useSyncData();
  const [drill, setDrill] = useState<Drill>(null);
  // Back closes the drill-down first, then the sheet.
  useHistoryDismiss(drill !== null, (o) => {
    if (!o) setDrill(null);
  });

  if (!sync) {
    return (
      <SheetHeader className="pb-6">
        <SheetTitle className="text-xl">Balance</SheetTitle>
        <SheetDescription>
          Your data hasn&rsquo;t loaded yet — try again in a moment.
        </SheetDescription>
      </SheetHeader>
    );
  }
  const names = namesFor(sync);

  if (target.kind === 'group') {
    return <GroupStandalone sync={sync} names={names} target={target} />;
  }

  const { friendId, currency } = target;
  if (drill?.kind === 'group') {
    const group = sync.groups.find((g) => g.id === drill.groupId);
    const x = explainGroup(sync, drill.groupId, currency, names.meId, friendId);
    return (
      <>
        <SheetHeader className="gap-2 pb-0">
          <BackButton onClick={() => setDrill(null)} />
          <SheetTitle className="text-xl">
            In {group ? `${group.emoji} ${group.name}` : 'this group'}
          </SheetTitle>
          <SheetDescription>{asOf(sync)}</SheetDescription>
        </SheetHeader>
        <Scroll>
          <GroupTrace sync={sync} names={names} x={x} />
        </Scroll>
      </>
    );
  }
  if (drill?.kind === 'direct') {
    return (
      <>
        <SheetHeader className="gap-2 pb-0">
          <BackButton onClick={() => setDrill(null)} />
          <SheetTitle className="text-xl">Direct expenses</SheetTitle>
          <SheetDescription>{asOf(sync)}</SheetDescription>
        </SheetHeader>
        <Scroll>
          <DirectTrace sync={sync} names={names} friendId={friendId} currency={currency} />
        </Scroll>
      </>
    );
  }

  const entry = explainFriend(sync, friendId).find((e) => e.currency === currency);
  const owesMe = (entry?.totalCents ?? 0) > 0;
  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="pr-8 text-xl">Balance breakdown</SheetTitle>
        <SheetDescription>
          You and {names.object(friendId)} · {asOf(sync)}
        </SheetDescription>
      </SheetHeader>
      <Scroll>
        {!entry ? (
          <p className="text-muted-foreground">
            You&rsquo;re all settled up with {names.object(friendId)} in {currency}.
          </p>
        ) : (
          <>
            {/* The answer first: the total, then where it comes from. */}
            <div className="flex flex-col gap-1 rounded-card bg-muted/50 px-5 py-4">
              <span className="text-sm text-muted-foreground">
                {owesMe
                  ? `${names.subject(friendId)} owes you`
                  : `You owe ${names.object(friendId)}`}
              </span>
              <MoneyText
                signed
                cents={entry.totalCents}
                currency={currency}
                className="text-3xl font-medium tracking-tight"
              />
              <span className="sr-only">
                {whyTitle(names, names.meId, friendId, entry.totalCents, currency)}
              </span>
            </div>
            <section className="flex flex-col gap-2">
              <h3 className="eyebrow px-1">Where it comes from</h3>
              <div className="flex flex-col rounded-panel bg-muted/50 px-4">
                {entry.slices.map((slice) => {
                  const group =
                    slice.scope === null ? null : sync.groups.find((g) => g.id === slice.scope);
                  const label = slice.scope === null ? 'Direct' : (group?.name ?? 'Group');
                  return (
                    <button
                      key={slice.scope ?? 'direct'}
                      type="button"
                      onClick={() =>
                        setDrill(
                          slice.scope === null
                            ? { kind: 'direct' }
                            : { kind: 'group', groupId: slice.scope },
                        )
                      }
                      className="flex min-h-16 w-full items-center gap-3 border-b border-border/60 py-3 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <ScopeBadge emoji={slice.scope === null ? null : (group?.emoji ?? '👥')} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-medium break-words">{label}</span>
                        <span className="text-xs text-muted-foreground">
                          {slice.cents > 0
                            ? `${names.subject(friendId)} owes you`
                            : `You owe ${names.object(friendId)}`}
                        </span>
                      </span>
                      <Signed
                        cents={slice.cents}
                        currency={currency}
                        className="text-sm font-medium"
                      />
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
              <p className="px-1 text-sm text-muted-foreground">
                Each group adds what Splitup routes between you there; Direct is bills outside any
                group. Tap one to see how it was worked out.
              </p>
            </section>
          </>
        )}
      </Scroll>
    </>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
}

/* ------------------------------------------------------- group (standalone) */

function GroupStandalone({
  sync,
  names,
  target,
}: {
  sync: SyncData;
  names: Names;
  target: Extract<ExplainTarget, { kind: 'group' }>;
}) {
  const { groupId, focusId, otherId } = target;
  const [currency, setCurrency] = useState(target.currency);
  const group = sync.groups.find((g) => g.id === groupId);
  const x = explainGroup(sync, groupId, currency, focusId, otherId);

  // Other currencies this person has something in, so a multi-currency row
  // can be explained without reopening.
  const currencies = [
    ...new Set([
      target.currency,
      group?.currency ?? target.currency,
      ...sync.expenses.filter((e) => e.groupId === groupId).map((e) => e.currency),
    ]),
  ]
    .sort()
    .filter(
      (c) => c === currency || explainGroup(sync, groupId, c, focusId, otherId).pairCents !== 0,
    );

  let title: string;
  if (otherId !== null && x.pairCents !== 0) {
    title = whyTitle(names, focusId, otherId, x.pairCents, currency);
  } else if (otherId !== null) {
    title = `${names.subject(focusId)} and ${names.object(otherId)}`;
  } else if (x.pairCents === 0) {
    title =
      focusId === names.meId ? 'You’re settled up here' : `${names.subject(focusId)} is settled up`;
  } else {
    const amount = formatMoney(Math.abs(x.pairCents), currency);
    const verb = x.pairCents > 0 ? 'get back' : 'owe';
    title =
      focusId === names.meId
        ? `Why do you ${verb} ${amount}?`
        : `Why does ${names.subject(focusId)} ${x.pairCents > 0 ? 'get back' : 'owe'} ${amount}?`;
  }

  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="pr-8 text-xl">{title}</SheetTitle>
        <SheetDescription>
          {group ? `${group.emoji} ${group.name} · ` : ''}
          {asOf(sync)}
        </SheetDescription>
      </SheetHeader>
      <Scroll>
        {currencies.length > 1 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Currency">
            {currencies.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={c === currency ? 'default' : 'outline'}
                className="rounded-full px-3"
                aria-pressed={c === currency}
                onClick={() => setCurrency(c)}
              >
                {c}
              </Button>
            ))}
          </div>
        ) : null}
        <GroupTrace sync={sync} names={names} x={x} />
      </Scroll>
    </>
  );
}

/* ------------------------------------------------------------ group trace */

function standing(cents: number, currency: string, they: boolean): React.ReactNode {
  if (cents === 0) return <>{they ? 'they’re' : 'you’re'} even</>;
  return (
    <>
      {they ? 'they’re' : 'you’re'}{' '}
      <Signed cents={cents} currency={currency} className="font-medium" />
    </>
  );
}

function PersonSummary({
  names,
  m,
  currency,
}: {
  names: Names;
  m: MemberTotals;
  currency: string;
}) {
  const isMe = m.userId === names.meId;
  const who = names.subject(m.userId);
  const their = isMe ? 'your' : 'their';
  const money = (c: number) => <span className="tabular-nums">{formatMoney(c, currency)}</span>;
  const sent = m.sentCents > 0 ? <>sent {money(m.sentCents)}</> : null;
  const received = m.receivedCents > 0 ? <>received {money(m.receivedCents)}</> : null;
  return (
    <p>
      {who} paid {money(m.paidCents)} and {their} share was {money(m.shareCents)}
      {sent || received ? (
        <>
          ; {isMe ? 'you' : 'they'} {sent}
          {sent && received ? ' and ' : null}
          {received} in settle-up payments
        </>
      ) : null}
      , so {standing(m.netCents, currency, !isMe)} overall in the group.
      {!m.current ? (
        <span className="text-muted-foreground">
          {' '}
          ({isMe ? 'You' : 'They'} have left the group.)
        </span>
      ) : null}
    </p>
  );
}

const emptyTotals = (userId: number): MemberTotals => ({
  userId,
  paidCents: 0,
  shareCents: 0,
  sentCents: 0,
  receivedCents: 0,
  netCents: 0,
  current: true,
});

function GroupTrace({ sync, names, x }: { sync: SyncData; names: Names; x: GroupExplanation }) {
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const { currency, focusId, otherId } = x;
  const totalsOf = (id: number) => x.members.find((m) => m.userId === id) ?? emptyTotals(id);
  const focus = totalsOf(focusId);
  const other = otherId === null ? null : totalsOf(otherId);
  const usersById = new Map(sync.users.map((u) => [u.id, u]));

  let headline: React.ReactNode;
  if (otherId === null) {
    headline =
      x.pairCents === 0 ? (
        <>
          {names.subject(focusId)} {focusId === names.meId ? 'are' : 'is'} even in this group.
        </>
      ) : (
        <>
          {names.subject(focusId)} {x.pairCents > 0 ? 'should get back' : 'should pay'}{' '}
          <MoneyText signed cents={x.pairCents} currency={currency} className="font-medium" /> in
          total here.
        </>
      );
  } else if (x.pairCents === 0) {
    headline = (
      <>
        Splitup doesn&rsquo;t route any money between {names.object(focusId)} and{' '}
        {names.object(otherId)} in this group right now.
      </>
    );
  } else {
    const [debtor, creditor] = x.pairCents > 0 ? [otherId, focusId] : [focusId, otherId];
    headline = (
      <>
        {names.subject(debtor)} {debtor === names.meId ? 'pay' : 'pays'} {names.object(creditor)}{' '}
        <MoneyText signed cents={x.pairCents} currency={currency} className="font-medium" /> in this
        group.
      </>
    );
  }

  const people = other ? [focus, other] : [focus];
  const shortName = (id: number) => (id === names.meId ? 'You' : names.subject(id).split(/\s+/)[0]);

  return (
    <>
      <div className="flex flex-col gap-3 rounded-panel bg-muted/50 p-4">
        <p className="text-base font-medium tracking-tight">{headline}</p>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground [&_p]:text-foreground/80">
          {people.map((m) => (
            <div key={m.userId} className="flex items-start gap-2.5">
              <UserAvatar user={usersById.get(m.userId)} size="sm" className="mt-0.5" />
              <PersonSummary names={names} m={m} currency={currency} />
            </div>
          ))}
        </div>
      </div>

      {/* Ledger: every row in this group + currency, collapsible. */}
      <section className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={ledgerOpen}
          onClick={() => setLedgerOpen((o) => !o)}
          className="flex min-h-11 items-center justify-between gap-3 rounded-full py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="eyebrow">
            {x.ledger.length === 1 ? '1 expense' : `${x.ledger.length} expenses`} in this group
          </span>
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform',
              ledgerOpen && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
        {ledgerOpen ? (
          <div className="flex flex-col rounded-panel bg-muted/50 px-4">
            {x.ledger.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                Nothing recorded in {currency} yet.
              </p>
            ) : (
              x.ledger.map(({ expense: e, focus: f, other: o }) => {
                const payers = e.shares.filter((s) => s.paidCents > 0);
                const paidBy =
                  payers.length === 1
                    ? `${names.subject(payers[0].userId)} paid`
                    : `${payers.length} people paid`;
                return (
                  <div
                    key={e.id}
                    className="flex items-start gap-3 border-b border-border/60 py-3 last:border-b-0"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">
                        {e.isPayment ? 'Payment' : e.description}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {formatDateSafe(e.date, 'MMM d', '—')} · {paidBy}{' '}
                        {formatMoney(e.amountCents, e.currency)}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                      {[
                        [focusId, f] as const,
                        ...(o && otherId !== null ? [[otherId, o] as const] : []),
                      ].map(([id, eff]) => (
                        <span key={id} className="flex items-baseline gap-1.5">
                          <span className="text-muted-foreground">{shortName(id)}</span>
                          {eff.paidCents === 0 && eff.owedCents === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Signed cents={eff.netCents} currency={currency} />
                          )}
                        </span>
                      ))}
                    </span>
                  </div>
                );
              })
            )}
            {x.ledger.length > 0 ? (
              <TotalRow label="Total">
                <span className="flex flex-col items-end gap-0.5 text-xs">
                  {people.map((m) => (
                    <span key={m.userId} className="flex items-baseline gap-1.5">
                      <span className="font-normal text-muted-foreground">
                        {shortName(m.userId)}
                      </span>
                      <Signed cents={m.netCents} currency={currency} />
                    </span>
                  ))}
                </span>
              </TotalRow>
            ) : null}
          </div>
        ) : null}
        <p className="px-1 text-xs text-muted-foreground">
          Each row moves a person&rsquo;s group total by what they paid minus their share.
        </p>
      </section>

      {/* The sweep. */}
      <section className="flex flex-col gap-3">
        <span className="eyebrow">How Splitup decided who pays whom</span>
        {x.steps.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">Everyone is even here in {currency}.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {x.steps.map((s) => (
              <li
                key={s.index}
                aria-current={s.highlighted ? 'true' : undefined}
                className={cn(
                  'flex flex-col gap-2 rounded-panel px-4 py-3',
                  s.highlighted ? 'bg-signal/10 ring-1 ring-signal/50' : 'bg-muted/50',
                )}
              >
                <span className="flex items-start gap-3 text-sm">
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                      s.highlighted
                        ? 'bg-signal text-signal-foreground'
                        : 'bg-background text-muted-foreground',
                    )}
                    aria-hidden="true"
                  >
                    {s.index + 1}
                  </span>
                  {/* A sentence that wraps: names and "you" are never cut. */}
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-medium">{names.subject(s.fromUserId)}</span>{' '}
                    <span className="text-muted-foreground">
                      {s.fromUserId === names.meId ? 'pay' : 'pays'}
                    </span>{' '}
                    <span className="font-medium">{names.object(s.toUserId)}</span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap tabular-nums">
                    {formatMoney(s.cents, currency)}
                  </span>
                </span>
                {/* Where this step sits on the line of everything owed. */}
                <span
                  className="relative h-1 overflow-hidden rounded-full bg-foreground/10"
                  aria-hidden="true"
                >
                  <span
                    className={cn(
                      'absolute inset-y-0 rounded-full',
                      s.highlighted ? 'bg-signal' : 'bg-foreground/30',
                    )}
                    style={{
                      left: `${(s.start / x.totalCents) * 100}%`,
                      width: `${Math.max((s.cents / x.totalCents) * 100, 1.5)}%`,
                    }}
                  />
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="px-1 text-sm text-muted-foreground">
          Splitup pairs people who owe with people who are owed, in a fixed order, to keep payments
          few. Other members&rsquo; expenses can change who you pay — never your total here.
        </p>
      </section>
    </>
  );
}

/* ----------------------------------------------------------- direct trace */

function DirectTrace({
  sync,
  names,
  friendId,
  currency,
}: {
  sync: SyncData;
  names: Names;
  friendId: number;
  currency: string;
}) {
  const x = explainDirect(sync, friendId, currency);
  const friend = names.object(friendId);
  return (
    <>
      <p className="text-muted-foreground">
        Bills and payments between you and {friend} outside any group, and what each did to your
        balance.
      </p>
      <div className="flex flex-col rounded-panel bg-muted/50 px-4">
        {x.items.map((item) => {
          if (item.kind === 'group') {
            const g = sync.groups.find((gr) => gr.id === item.groupId);
            return (
              <div
                key={`g${item.groupId}`}
                className="flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">
                    {g ? `${g.emoji} ${g.name}` : 'A group'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Older {currency} entries in a {g?.currency ?? 'different'} group — counted here
                  </span>
                </span>
                <Signed cents={item.cents} currency={currency} className="text-sm font-medium" />
              </div>
            );
          }
          const e = item.expense;
          const label = e.isPayment
            ? item.cents < 0
              ? `${names.subject(friendId)} paid you`
              : `You paid ${friend}`
            : item.cents > 0
              ? 'You lent'
              : item.cents < 0
                ? 'You borrowed'
                : 'No effect';
          return (
            <div
              key={e.id}
              className="flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  {e.isPayment ? 'Payment' : e.description}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {formatDateSafe(e.date, 'MMM d', '—')} · {label}
                </span>
              </span>
              <Signed cents={item.cents} currency={currency} className="text-sm font-medium" />
            </div>
          );
        })}
        <TotalRow label="Total">
          <Signed cents={x.totalCents} currency={currency} />
        </TotalRow>
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        + means {names.subject(friendId)} owes you more; − means you owe {friend} more.
      </p>
    </>
  );
}
