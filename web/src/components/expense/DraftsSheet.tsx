import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CloudOff, FilePenLine, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage, isKeyReused, isRemovedSince } from '@/lib/api';
import { formatDateSafe } from '@/lib/dates';
import { currentDrafts, removeDraft, useDrafts } from '@/lib/draft-store';
import { draftsInScope, validateDraft, type Draft, type DraftScope } from '@/lib/drafts';
import { formatMoney, parseAmountToCents } from '@/lib/money';
import { properName } from '@/lib/names';
import { SYNC_KEY, useCreateExpense, useSyncData } from '@/lib/queries';
import type { SyncData } from '@/lib/types';
import { useDraftsUi } from './drafts-ui';

/** "Drafts (2)" pill for a screen; renders nothing when the scope has none. */
export function DraftsChip({ scope, className }: { scope: DraftScope; className?: string }) {
  const { data: sync } = useSyncData();
  const drafts = useDrafts(sync?.me.id);
  const { openDrafts } = useDraftsUi();
  const count = drafts ? draftsInScope(drafts.drafts, scope).length : 0;
  if (count === 0) return null;
  return (
    <Button
      variant="outline"
      className={`h-10 rounded-full border-signal/50 px-4 ${className ?? ''}`}
      onClick={() => openDrafts(scope)}
    >
      <FilePenLine data-icon="inline-start" aria-hidden="true" />
      Drafts ({count})
    </Button>
  );
}

/** Same wording as the form's scope field: "In Flat 4B" / "Direct with Darshna Gupta". */
function scopeLabel(draft: Draft, sync: SyncData): string {
  const { groupId, friendId } = draft.values;
  if (groupId !== null) {
    const name = sync.groups.find((g) => g.id === groupId)?.name;
    return name ? `In ${name}` : 'In a group';
  }
  if (friendId === null) return 'No group or friend chosen';
  const name = sync.users.find((u) => u.id === friendId)?.name ?? draft.names[friendId];
  return name ? `Direct with ${properName(name)}` : 'Direct with a friend';
}

/**
 * The saved drafts (all, or one group's / friend's). Each row shows whether it
 * still validates against the current data; tapping opens it for review.
 * "Add all" submits them one by one with their own keys, stopping at the
 * first problem, and is only offered when every draft is ready.
 */
export default function DraftsSheet({
  open,
  onOpenChange,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: DraftScope;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full max-w-xl gap-0 rounded-t-card"
      >
        <DraftsBody scope={scope} onOpenChange={onOpenChange} />
      </SheetContent>
    </Sheet>
  );
}

function DraftsBody({
  scope,
  onOpenChange,
}: {
  scope: DraftScope;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const { data: sync } = useSyncData();
  const drafts = useDrafts(sync?.me.id);
  const { openDraft } = useDraftsUi();
  const createExpense = useCreateExpense();
  const [adding, setAdding] = useState(false);

  if (!sync || !drafts) return null;
  const list = draftsInScope(drafts.drafts, scope);
  const checks = new Map(list.map((d) => [d.id, validateDraft(d, sync)]));
  const allReady = list.length > 0 && list.every((d) => checks.get(d.id)?.ok);

  const addAll = async () => {
    setAdding(true);
    let added = 0;
    const meId = sync.me.id;
    const ids = list.map((d) => d.id);
    for (const id of ids) {
      const draft = currentDrafts(meId).find((d) => d.id === id);
      if (!draft) continue; // added/discarded meanwhile
      // Re-check against the freshest data before each submit.
      const latest = qc.getQueryData<SyncData>(SYNC_KEY) ?? sync;
      const res = validateDraft(draft, latest);
      if (!res.ok || !res.input) {
        toast.error(`Stopped at “${draft.values.description || 'Untitled'}”`, {
          description: res.issues[0] ?? 'Review it first.',
        });
        break;
      }
      try {
        await createExpense.mutateAsync({
          ...res.input,
          clientKey: draft.clientKey,
        });
        removeDraft(meId, draft.id);
        added += 1;
      } catch (err) {
        if (isKeyReused(err)) {
          // An earlier save of this draft went through before it was edited:
          // keep the draft (and its edits) for the user to sort out.
          toast.error(`“${draft.values.description || 'Untitled'}” was already added`, {
            description: 'This draft was already added — open it to edit.',
          });
          void qc.invalidateQueries({ queryKey: SYNC_KEY });
        } else {
          toast.error(`Couldn’t add “${draft.values.description}”`, {
            description: errorMessage(err),
          });
          if (isRemovedSince(err)) void qc.invalidateQueries({ queryKey: SYNC_KEY });
        }
        break;
      }
    }
    setAdding(false);
    if (added > 0) toast(added === 1 ? 'Added 1 expense' : `Added ${added} expenses`);
    if (added === ids.length) onOpenChange(false);
  };

  return (
    <>
      <SheetHeader className="pr-14">
        <SheetTitle className="text-xl">Drafts</SheetTitle>
        <SheetDescription>
          Saved on this device only — they don’t change any balances until you add them.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {list.length === 0 ? (
          <FieldDescription className="py-6 text-center">No drafts left.</FieldDescription>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 rounded-card bg-muted/60 px-4">
            {list.map((d) => {
              const check = checks.get(d.id);
              const cents = parseAmountToCents(d.values.amountRaw, d.values.currency);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    disabled={adding}
                    onClick={() => openDraft(d.id)}
                    className="flex min-h-16 w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center self-start rounded-full bg-background">
                      <CategoryIcon
                        category={d.values.category}
                        className="size-4 text-foreground/70"
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="line-clamp-2 font-medium break-words">
                        {d.values.description || 'Untitled'}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatDateSafe(d.values.date, 'MMM d', '—')} · {scopeLabel(d, sync)}
                      </span>
                      {check && !check.ok ? (
                        <span className="flex items-start gap-1.5 text-sm text-warning">
                          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          <span>Needs review · {check.issues[0]}</span>
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Ready to add</span>
                      )}
                    </span>
                    <span className="shrink-0 text-sm font-medium tabular-nums">
                      {cents !== null ? formatMoney(cents, d.values.currency) : '—'}
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {!online ? (
          <FieldDescription className="flex items-center justify-center gap-1.5 text-center">
            <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
            You’re offline — add them when you’re back online.
          </FieldDescription>
        ) : list.length > 1 && !allReady ? (
          <FieldDescription className="text-center">
            Review the drafts marked above to add them all at once.
          </FieldDescription>
        ) : null}
        {list.length > 1 ? (
          <Button
            size="cta"
            className="w-full"
            disabled={!online || !allReady || adding}
            onClick={() => void addAll()}
          >
            {adding ? <Spinner data-icon="inline-start" /> : null}
            Add all {list.length} expenses
          </Button>
        ) : null}
      </SheetFooter>
    </>
  );
}
