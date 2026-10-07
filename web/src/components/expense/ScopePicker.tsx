import { useMemo, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronRight, Lock, Plus, Search } from 'lucide-react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { scopeTitle, type ScopeChoice } from '@/lib/expense-form';
import { scopeKey, scopeOptions, type ScopeOption } from '@/lib/scope';
import type { SyncData } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Emoji disc for a group / avatar for a friend, sized for rows and the chip. */
function ScopeMark({ option, sync }: { option: ScopeOption | null; sync: SyncData }) {
  if (option?.group) {
    return (
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-background text-lg"
      >
        {option.group.emoji}
      </span>
    );
  }
  if (option?.user) {
    const user = sync.users.find((u) => u.id === option.user!.id) ?? option.user;
    return <UserAvatar user={user} className="size-10" />;
  }
  return null;
}

function optionFor(sync: SyncData, choice: ScopeChoice | null): ScopeOption | null {
  if (!choice) return null;
  const key = scopeKey(choice);
  const all = scopeOptions(sync, '');
  const found = [...all.groups, ...all.friends].find((o) => o.key === key);
  if (found) return found;
  // Archived groups (or a friend no longer listed) still show what they are.
  const group = choice.kind === 'group' ? sync.groups.find((g) => g.id === choice.groupId) : null;
  const user = choice.kind === 'friend' ? sync.users.find((u) => u.id === choice.friendId) : null;
  return {
    choice,
    key,
    name: group?.name ?? user?.name ?? '',
    detail: group ? `${group.memberIds.length} people · ${group.currency}` : 'Just the two of you',
    ...(group ? { group } : {}),
    ...(user ? { user } : {}),
  };
}

/**
 * Where the expense goes — the first field of the expense form. Unchosen it
 * reads "Choose a group or friend"; chosen it reads "In Flat 4B" / "Direct
 * with Darshna Gupta". Read-only for edits and recurring bills (an expense
 * never moves between groups).
 */
export function ScopeField({
  id,
  sync,
  value,
  onChange,
  readOnly = false,
  invalid = false,
  describedBy,
}: {
  id: string;
  sync: SyncData;
  value: ScopeChoice | null;
  onChange: (next: ScopeChoice) => void;
  readOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const option = optionFor(sync, value);
  const title = value ? scopeTitle(value, sync) : null;

  if (readOnly) {
    return (
      <div
        id={id}
        tabIndex={-1}
        className="flex min-h-14 items-center gap-3 rounded-panel bg-muted/60 px-3 py-2"
      >
        <ScopeMark option={option} sync={sync} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium break-words">{title}</span>
          {option ? <span className="text-sm text-muted-foreground">{option.detail}</span> : null}
        </span>
        <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Can't be changed" />
      </div>
    );
  }

  return (
    <>
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => setOpen(true)}
        className={cn(
          'pressable flex min-h-14 w-full items-center gap-3 rounded-panel px-3 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-focus-ring',
          value
            ? 'bg-muted/60 hover:bg-muted'
            : 'border border-dashed border-input hover:bg-muted/40',
          invalid && 'border-solid border-destructive ring-3 ring-destructive/20',
        )}
      >
        {value ? (
          <ScopeMark option={option} sync={sync} />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted"
          >
            <Plus className="size-5" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          {value ? (
            <>
              <span className="font-medium break-words">{title}</span>
              {option ? (
                <span className="text-sm text-muted-foreground">{option.detail}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className="font-medium">Choose a group or friend</span>
              <span className="text-sm text-muted-foreground">Where this expense goes</span>
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
          {value ? 'Change' : null}
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      </button>
      <ScopePickerSheet
        open={open}
        onOpenChange={setOpen}
        sync={sync}
        value={value}
        onPick={(choice) => {
          onChange(choice);
          setOpen(false);
        }}
      />
    </>
  );
}

/** The searchable chooser: Groups (recent activity first), then direct with a friend. */
export function ScopePickerSheet({
  open,
  onOpenChange,
  sync,
  value,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sync: SyncData;
  value: ScopeChoice | null;
  onPick: (choice: ScopeChoice) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full data-[side=bottom]:h-[85dvh] max-w-xl gap-0 rounded-t-card"
      >
        <PickerBody sync={sync} value={value} onPick={onPick} />
      </SheetContent>
    </Sheet>
  );
}

function PickerBody({
  sync,
  value,
  onPick,
}: {
  sync: SyncData;
  value: ScopeChoice | null;
  onPick: (choice: ScopeChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const { groups, friends } = useMemo(() => scopeOptions(sync, query), [sync, query]);
  const selected = value ? scopeKey(value) : null;
  const nothingAtAll = sync.groups.length === 0 && sync.friendIds.length === 0;

  const row = (o: ScopeOption, label: ReactNode) => (
    <li key={o.key}>
      <button
        type="button"
        aria-pressed={o.key === selected}
        onClick={() => onPick(o.choice)}
        className={cn(
          'flex min-h-14 w-full items-center gap-3 rounded-panel px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring',
          o.key === selected && 'bg-accent',
        )}
      >
        <ScopeMark option={o} sync={sync} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium break-words">{label}</span>
          <span className="text-sm text-muted-foreground">{o.detail}</span>
        </span>
        {o.key === selected ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
      </button>
    </li>
  );

  return (
    <>
      <SheetHeader className="pr-14">
        <SheetTitle className="text-xl">Add expense to…</SheetTitle>
        <SheetDescription>A group, or directly with one friend.</SheetDescription>
      </SheetHeader>
      {nothingAtAll ? (
        <p className="px-4 pb-8 text-sm text-muted-foreground">
          Add a friend or create a group first — every expense is shared with someone.
        </p>
      ) : (
        <>
          <div className="px-4 pb-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="text"
                enterKeyHint="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search groups and friends"
                aria-label="Search groups and friends"
                autoComplete="off"
                className="h-11 rounded-full pl-10"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {groups.length > 0 ? (
              <section aria-labelledby="scope-groups" className="pt-2">
                <h3 id="scope-groups" className="px-3 pb-1 text-sm font-medium text-muted-foreground">
                  Groups
                </h3>
                <ul className="flex flex-col gap-0.5">{groups.map((g) => row(g, `In ${g.name}`))}</ul>
              </section>
            ) : null}
            {friends.length > 0 ? (
              <section aria-labelledby="scope-friends" className="pt-4">
                <h3 id="scope-friends" className="px-3 pb-1 text-sm font-medium text-muted-foreground">
                  Direct with a friend
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {friends.map((f) => row(f, `Direct with ${f.name}`))}
                </ul>
              </section>
            ) : null}
            {groups.length === 0 && friends.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No groups or friends match “{query.trim()}”.
              </p>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
