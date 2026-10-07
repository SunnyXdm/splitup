import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, CloudOff, History, Plus, Repeat2, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { CategoryIcon } from '@/components/common/CategoryIcon';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import { UserAvatar } from '@/components/common/UserAvatar';
import { currencyPickerOptions } from '@/components/common/currency-options';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CATEGORIES, CATEGORY_META } from '@/lib/categories';
import { errorMessage, isConflict, scanErrorMessage, scanReceipt } from '@/lib/api';
import { createClientKeyTracker, newClientKey } from '@/lib/client-key';
import { currentDrafts, removeDraft, saveAutosave, saveDraft, useDrafts } from '@/lib/draft-store';
import { autosaveScopeKey, createDraft, type Draft, type DraftsState } from '@/lib/drafts';
import {
  checkFormValues,
  emptyFormValues,
  formValuesFromExpense,
  participantIdsFor,
  revalidateFormValues,
  sameFormValues,
  userById,
  type ExpenseFormValues,
} from '@/lib/expense-form';
import { downscaleImage, receiptPrefill } from '@/lib/receipt';
import { buildRepeatPrefill } from '@/lib/repeat';
import { formatMoney, isCanonicalAmount } from '@/lib/money';
import {
  SYNC_KEY,
  useCreateExpense,
  useDeleteExpense,
  useSyncData,
  useUpdateExpense,
} from '@/lib/queries';
import type { Category, Expense, SyncData, User } from '@/lib/types';
import ExpenseHistorySheet from './ExpenseHistorySheet';
import { centsToInput, currencySymbol } from './money-input';
import { PayerPicker, defaultPayerState } from './PayerPicker';
import { SplitEditor, defaultSplitState } from './SplitEditor';

export interface ExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group to add the expense to; null = non-group (1:1 with a friend). */
  groupId: number | null;
  /** Present = edit mode. */
  expense?: Expense;
  /** Preselect this friend for non-group expenses. */
  friendId?: number;
  /** Present = review a saved draft (its own scope wins over groupId/friendId). */
  draftId?: string;
}

export default function ExpenseForm({
  open,
  onOpenChange,
  groupId,
  expense,
  friendId,
  draftId,
}: ExpenseFormProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl rounded-t-[28px]"
      >
        {/* Mounted only while the sheet is open, so state resets between uses
            (in-progress new expenses survive via the draft autosave). */}
        <FormBody
          onOpenChange={onOpenChange}
          groupId={groupId}
          expense={expense}
          friendId={friendId}
          draftId={draftId}
        />
      </SheetContent>
    </Sheet>
  );
}

interface ScanReview {
  warnings: string[];
  confidence: 'high' | 'medium' | 'low';
  /** The model's own remark about something unclear, if any. */
  remark: string | null;
}

type FormMode =
  | { kind: 'new' }
  | { kind: 'edit'; expense: Expense }
  | { kind: 'repeat'; expense: Expense }
  | { kind: 'draft'; draftId: string };

const TITLES: Record<FormMode['kind'], string> = {
  new: 'Add expense',
  edit: 'Edit expense',
  repeat: 'Repeat expense',
  draft: 'Review draft',
};

function FormBody({
  onOpenChange,
  groupId,
  expense,
  friendId,
  draftId,
}: Omit<ExpenseFormProps, 'open'>) {
  const { data: sync } = useSyncData();
  const drafts = useDrafts(sync?.me.id);
  // "Repeat" turns this sheet from editing an expense into adding a copy of it.
  const [repeatOf, setRepeatOf] = useState<Expense | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const mode: FormMode = repeatOf
    ? { kind: 'repeat', expense: repeatOf }
    : draftId !== undefined
      ? { kind: 'draft', draftId }
      : expense
        ? { kind: 'edit', expense }
        : { kind: 'new' };
  return (
    <>
      <SheetHeader className="flex-row items-center gap-2 pr-14 pb-0">
        <SheetTitle className="text-xl">{TITLES[mode.kind]}</SheetTitle>
        {mode.kind === 'edit' ? (
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="rounded-full"
              aria-label="History — see and restore earlier versions"
              title="History"
              onClick={() => setHistoryOpen(true)}
            >
              <History aria-hidden="true" />
            </Button>
            {!mode.expense.isPayment ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                aria-label="Repeat this expense — add a copy dated today"
                onClick={() => setRepeatOf(mode.expense)}
              >
                <Repeat2 data-icon="inline-start" aria-hidden="true" />
                Repeat
              </Button>
            ) : null}
          </div>
        ) : null}
      </SheetHeader>
      {mode.kind === 'edit' ? (
        <ExpenseHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          expense={mode.expense}
          // The form holds the pre-restore values: close it so nothing stale is saved.
          onRestored={() => onOpenChange(false)}
        />
      ) : null}
      {!sync ? (
        <FieldDescription className="px-4 pb-6">
          Your data hasn't loaded yet — try again in a moment.
        </FieldDescription>
      ) : !drafts ? (
        <div className="flex justify-center px-4 pb-8">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      ) : (
        <FormFields
          key={mode.kind}
          sync={sync}
          drafts={drafts}
          mode={mode}
          onOpenChange={onOpenChange}
          groupId={groupId}
          friendId={friendId}
        />
      )}
    </>
  );
}

interface InitialForm {
  values: ExpenseFormValues;
  /** The scope's blank form (new/repeat): autosaving it clears the slot. */
  blank: ExpenseFormValues | null;
  /** Autosave slot (new/repeat only). */
  scopeKey: string | null;
  /** Revalidation notes ("Removed Asha — no longer in this group"). */
  notes: string[];
  /** An autosaved in-progress form was restored. */
  restored: boolean;
  /** The values can't be used at all. */
  blocking: string | null;
  draft: Draft | null;
  /** Edit mode: departed members' shares stay in play. */
  participantIds: number[] | null;
}

function initialForm(
  mode: FormMode,
  sync: SyncData,
  drafts: DraftsState,
  groupId: number | null,
  friendId: number | undefined,
): InitialForm {
  const meId = sync.me.id;
  const base = {
    blank: null,
    scopeKey: null,
    notes: [],
    restored: false,
    blocking: null,
    draft: null,
    participantIds: null,
  };
  switch (mode.kind) {
    case 'edit': {
      const { expense } = mode;
      const group = sync.groups.find((g) => g.id === expense.groupId);
      // Editing keeps departed members' shares in play (union with the current
      // roster) — silently dropping them would redistribute their portion.
      const participantIds = group
        ? [...new Set([...group.memberIds, ...expense.shares.map((s) => s.userId)])]
        : [meId, ...expense.shares.map((s) => s.userId).filter((id) => id !== meId).slice(0, 1)];
      return {
        ...base,
        values: formValuesFromExpense(expense, meId, participantIds),
        participantIds,
      };
    }
    case 'repeat': {
      const { expense } = mode;
      const rv = buildRepeatPrefill(expense, sync);
      const scope = {
        groupId: expense.groupId,
        friendId:
          expense.groupId === null
            ? (expense.shares.find((s) => s.userId !== meId)?.userId ?? null)
            : null,
      };
      return {
        ...base,
        values: rv.values,
        blank: emptyFormValues(sync, scope),
        scopeKey: autosaveScopeKey(scope),
        notes: rv.notes,
        blocking: rv.blocking,
      };
    }
    case 'draft': {
      const draft = drafts.drafts.find((d) => d.id === mode.draftId) ?? null;
      if (!draft) {
        return {
          ...base,
          values: emptyFormValues(sync, { groupId: null }),
          blocking: 'This draft was already added or discarded.',
        };
      }
      const rv = revalidateFormValues(draft.values, sync, draft.names);
      return { ...base, values: rv.values, notes: rv.notes, blocking: rv.blocking, draft };
    }
    case 'new': {
      const scope = { groupId, friendId };
      const blank = emptyFormValues(sync, scope);
      const scopeKey = autosaveScopeKey(scope);
      const saved = drafts.autosaves[scopeKey];
      if (saved && !sameFormValues(saved.values, blank)) {
        const rv = revalidateFormValues(saved.values, sync);
        if (!rv.blocking) {
          return { ...base, values: rv.values, blank, scopeKey, notes: rv.notes, restored: true };
        }
      }
      return { ...base, values: blank, blank, scopeKey };
    }
  }
}

function FormFields({
  sync,
  drafts,
  mode,
  onOpenChange,
  groupId: groupIdProp,
  friendId,
}: {
  sync: SyncData;
  drafts: DraftsState;
  mode: FormMode;
  onOpenChange: (open: boolean) => void;
  groupId: number | null;
  friendId?: number;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const keyFor = useRef(createClientKeyTracker()).current;
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();

  const me = sync.me;
  const [init] = useState(() => initialForm(mode, sync, drafts, groupIdProp, friendId));
  const [values, setValues] = useState<ExpenseFormValues>(init.values);
  const [notices, setNotices] = useState(init.notes);
  const [restored, setRestored] = useState(init.restored);
  const set = <K extends keyof ExpenseFormValues>(key: K, value: ExpenseFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const expense = mode.kind === 'edit' ? mode.expense : undefined;
  const isEdit = expense !== undefined;
  const { groupId, currency } = values;
  const group = groupId !== null ? (sync.groups.find((g) => g.id === groupId) ?? null) : null;

  const [attempted, setAttempted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // --- Autosave: the in-progress form (or the draft under review) is written
  // to this device, debounced, and once more when the sheet closes. Nothing is
  // written until the user changes something; never after it was saved.
  const dirty = useRef(false);
  const finished = useRef(false);
  const persist = useEffectEvent(() => {
    if (finished.current || !dirty.current || init.blocking) return;
    if (mode.kind === 'draft') {
      const current = currentDrafts(me.id).find((d) => d.id === init.draft?.id);
      if (current) saveDraft(me.id, { ...current, values, updatedAt: new Date().toISOString() });
    } else if (init.scopeKey !== null && init.blank !== null) {
      saveAutosave(me.id, init.scopeKey, sameFormValues(values, init.blank) ? null : values);
    }
  });
  useEffect(() => {
    if (mode.kind === 'edit') return;
    if (!dirty.current && sameFormValues(values, init.values)) return;
    dirty.current = true;
    const t = setTimeout(() => persist(), 400);
    return () => clearTimeout(t);
  }, [values, init.values, mode.kind]);
  useEffect(() => () => persist(), []);

  /** Saved for good: stop autosaving and clear this form's slot. */
  const finish = () => {
    finished.current = true;
    if (init.scopeKey !== null && mode.kind !== 'draft') saveAutosave(me.id, init.scopeKey, null);
  };

  const discardRestored = () => {
    if (!init.blank) return;
    dirty.current = true;
    setValues(init.blank);
    setRestored(false);
    setNotices([]);
    setAttempted(false);
    if (init.scopeKey !== null) saveAutosave(me.id, init.scopeKey, null);
  };

  // Receipt scanning (new expenses only). The scan only prefills fields — the
  // user still picks payer/split and has to press Save.
  const canScan = mode.kind === 'new' && sync.features?.receiptScan === true;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanReview, setScanReview] = useState<ScanReview | null>(null);
  useEffect(() => () => scanAbort.current?.abort(), []);

  const handleReceiptFile = async (file: File | undefined) => {
    if (!file) return;
    scanAbort.current?.abort();
    const ctrl = new AbortController();
    scanAbort.current = ctrl;
    setScanning(true);
    setScanReview(null);
    try {
      let image: string;
      try {
        image = await downscaleImage(file);
      } catch {
        toast.error("Couldn't open that photo — try another one.");
        return;
      }
      if (ctrl.signal.aborted) return;
      const { draft, warnings } = await scanReceipt(image, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const p = receiptPrefill(draft, currency, group === null);
      const formCurrency = p.currency ?? currency;
      setValues((prev) => ({
        ...prev,
        ...(p.description ? { description: p.description } : {}),
        ...(p.currency ? { currency: p.currency } : {}),
        ...(p.amountCents !== null
          ? { amountRaw: centsToInput(p.amountCents, formCurrency) }
          : {}),
        ...(p.date ? { date: p.date } : {}),
        category: p.category,
        ...(p.notes ? { notes: p.notes, showNotes: true } : {}),
      }));
      setScanReview({
        warnings: [...(p.currencyNotice ? [p.currencyNotice] : []), ...warnings],
        confidence: draft.confidence,
        remark: draft.notes,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      toast.error(scanErrorMessage(err));
    } finally {
      if (scanAbort.current === ctrl) {
        scanAbort.current = null;
        setScanning(false);
      }
    }
  };

  const cancelScan = () => {
    scanAbort.current?.abort();
    scanAbort.current = null;
    setScanning(false);
  };

  const participantIds = init.participantIds ?? participantIdsFor(values, sync);
  const participantKey = participantIds.join(',');
  const participants: User[] = useMemo(
    () => participantKey.split(',').filter(Boolean).map((id) => userById(sync, Number(id))),
    [sync, participantKey],
  );

  const friendOptions: User[] = useMemo(() => {
    const ids = new Set<number>(sync.friendIds);
    if (values.friendId !== null) ids.add(values.friendId);
    return [...ids].map((id) => userById(sync, id));
  }, [sync, values.friendId]);

  // Changing the counterparty resets who-paid and the split to sane defaults.
  const changeFriend = (id: number) => {
    setValues((prev) => ({
      ...prev,
      friendId: id,
      payer: defaultPayerState(me.id),
      split: defaultSplitState([me.id, id]),
    }));
  };

  const check = checkFormValues(values, participants, me.id);
  const { amountCents } = check;
  const descriptionError = check.errors.description;
  const amountError = check.errors.amount;
  const dateError = check.errors.date;
  const friendError = check.errors.friend;

  const saving = createExpense.isPending || updateExpense.isPending;
  const draft = init.draft;
  /** Offline, a new expense (or a draft under review) is kept as a draft. */
  const savesAsDraft = !online && mode.kind !== 'edit';

  const handleSave = () => {
    setAttempted(true);
    const input = check.input;
    if (!input) return;
    if (savesAsDraft) {
      if (draft) {
        const current = currentDrafts(me.id).find((d) => d.id === draft.id) ?? draft;
        saveDraft(me.id, { ...current, values, updatedAt: new Date().toISOString() });
        finish();
        toast('Draft updated');
      } else {
        // The idempotency key is minted NOW and travels with the draft, so
        // however often it is submitted later it can only be recorded once.
        saveDraft(me.id, createDraft(values, sync, { id: newClientKey(), clientKey: newClientKey() }));
        finish();
        toast('Draft saved', {
          description: 'You can add it once you’re back online.',
        });
      }
      onOpenChange(false);
      return;
    }
    const callbacks = {
      onSuccess: () => {
        if (draft) removeDraft(me.id, draft.id);
        toast(isEdit ? 'Expense updated' : 'Expense added');
        onOpenChange(false);
      },
      onError: (err: Error) => {
        // Not saved after all: keep autosaving what's on screen.
        finished.current = false;
        toast.error(errorMessage(err));
        if (isConflict(err)) {
          // Our copy is outdated: close and pull the latest so a reopen
          // starts from what the other person saved.
          void qc.invalidateQueries({ queryKey: SYNC_KEY });
          onOpenChange(false);
        }
      },
    };
    if (expense) {
      updateExpense.mutate(
        // `expense` is the snapshot this edit started from — its updatedAt is
        // the conflict token, even if a refetch has updated the cache since.
        { id: expense.id, expectedUpdatedAt: expense.updatedAt, ...input },
        callbacks,
      );
    } else {
      finish();
      createExpense.mutate(
        { ...input, clientKey: draft ? draft.clientKey : keyFor(input) },
        callbacks,
      );
    }
  };

  const discardDraft = () => {
    if (!draft) return;
    finished.current = true;
    removeDraft(me.id, draft.id);
    toast('Draft discarded');
    onOpenChange(false);
  };

  const handleDelete = () => {
    if (!expense) return;
    deleteExpense.mutate(expense.id, {
      onSuccess: () => {
        toast('Expense deleted');
        setConfirmOpen(false);
        onOpenChange(false);
      },
      onError: (err: Error) => toast.error(errorMessage(err)),
    });
  };

  if (init.blocking) {
    return (
      <div className="flex flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <FieldDescription>{init.blocking}</FieldDescription>
        {draft ? (
          <Button variant="outline" className="h-12 w-full rounded-full" onClick={discardDraft}>
            <Trash2 data-icon="inline-start" />
            Discard draft
          </Button>
        ) : null}
      </div>
    );
  }

  if (groupId !== null && !group) {
    return (
      <FieldDescription className="px-4 pb-6">
        This group isn't available anymore.
      </FieldDescription>
    );
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup className="pb-2">
          {restored || notices.length > 0 || mode.kind === 'repeat' ? (
            <FormNotice
              title={
                restored
                  ? 'Draft restored'
                  : mode.kind === 'repeat'
                    ? 'Repeating with today’s date'
                    : notices.length > 0
                      ? 'Some things changed since this draft'
                      : null
              }
              notes={notices}
              onDiscard={restored ? discardRestored : undefined}
            />
          ) : null}
          {canScan ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so picking the same photo again still fires onChange.
                  e.target.value = '';
                  void handleReceiptFile(file);
                }}
              />
              {scanning ? (
                <ScanningCard onCancel={cancelScan} />
              ) : scanReview ? (
                <ScanReviewBanner
                  review={scanReview}
                  onRescan={() => fileInputRef.current?.click()}
                  rescanDisabled={!online}
                  onDismiss={() => setScanReview(null)}
                />
              ) : online ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full rounded-full"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Camera data-icon="inline-start" />
                  Scan receipt
                </Button>
              ) : null}
            </>
          ) : null}

          <Field data-invalid={attempted && descriptionError !== null}>
            <FieldLabel htmlFor="expense-description">Description</FieldLabel>
            <Input
              id="expense-description"
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={200}
              placeholder="Dinner, taxi, rent…"
              className="h-11 rounded-full px-4"
            />
            {attempted && descriptionError ? (
              <FieldDescription className="text-destructive">{descriptionError}</FieldDescription>
            ) : null}
          </Field>

          <Field data-invalid={attempted && amountError !== null}>
            <FieldLabel htmlFor="expense-amount">Amount</FieldLabel>
            <InputGroup className="h-11 rounded-full">
              {group ? (
                <InputGroupAddon className="pl-3.5">
                  <InputGroupText>{currencySymbol(currency)}</InputGroupText>
                </InputGroupAddon>
              ) : (
                <InputGroupAddon className="pl-1.5">
                  <PickerSelect
                    title="Currency"
                    aria-label="Currency"
                    className="h-8 w-auto border-0 px-2.5 font-medium"
                    value={currency}
                    onValueChange={(v) => set('currency', v)}
                    options={currencyPickerOptions()}
                  />
                </InputGroupAddon>
              )}
              <InputGroupInput
                id="expense-amount"
                inputMode="decimal"
                placeholder={centsToInput(0, currency)}
                value={values.amountRaw}
                onChange={(e) => set('amountRaw', e.target.value)}
              />
              {group ? (
                <InputGroupAddon align="inline-end" className="pr-3.5">
                  <InputGroupText>{currency}</InputGroupText>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            {attempted && amountError ? (
              <FieldDescription className="text-destructive">{amountError}</FieldDescription>
            ) : amountCents !== null && !isCanonicalAmount(values.amountRaw) ? (
              // Anything but a plain "12.50" (math, "12,50", grouping) shows
              // how it was read, so a misparse can't slip through unseen.
              <FieldDescription>= {formatMoney(amountCents, currency)}</FieldDescription>
            ) : null}
          </Field>

          {groupId === null && !isEdit ? (
            <Field data-invalid={attempted && friendError !== null}>
              <FieldLabel htmlFor="expense-friend">With</FieldLabel>
              {friendOptions.length === 0 ? (
                <FieldDescription className={attempted ? 'text-destructive' : undefined}>
                  {friendError}
                </FieldDescription>
              ) : (
                <PickerSelect
                  id="expense-friend"
                  title="Split with"
                  placeholder="Choose a friend"
                  value={values.friendId !== null ? String(values.friendId) : null}
                  onValueChange={(v) => changeFriend(Number(v))}
                  options={friendOptions.map((f) => ({
                    value: String(f.id),
                    label: f.name,
                    leading: <UserAvatar user={f} size="sm" />,
                  }))}
                />
              )}
            </Field>
          ) : null}

          <Field data-invalid={attempted && dateError !== null}>
            <FieldLabel htmlFor="expense-date">Date</FieldLabel>
            <Input
              id="expense-date"
              type="date"
              value={values.date}
              onChange={(e) => set('date', e.target.value)}
              className="h-11 rounded-full px-4"
            />
            {attempted && dateError ? (
              <FieldDescription className="text-destructive">{dateError}</FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Category</FieldLabel>
            <ToggleGroup
              value={[values.category]}
              onValueChange={(v) => {
                if (v[0]) set('category', v[0] as Category);
              }}
              className="-mx-4 w-auto justify-start overflow-x-auto px-4 pb-1"
              aria-label="Category"
            >
              {CATEGORIES.map((c) => (
                <ToggleGroupItem
                  key={c}
                  value={c}
                  variant="outline"
                  className="h-11 shrink-0 gap-1.5 rounded-full px-4 aria-pressed:border-primary"
                >
                  <CategoryIcon category={c} />
                  {CATEGORY_META[c].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          {values.showNotes ? (
            <Field>
              <FieldLabel htmlFor="expense-notes">Notes</FieldLabel>
              <Textarea
                id="expense-notes"
                value={values.notes}
                onChange={(e) => set('notes', e.target.value)}
                maxLength={1000}
                placeholder="Anything worth remembering"
                className="rounded-[20px] px-4"
              />
            </Field>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start rounded-full"
              onClick={() => set('showNotes', true)}
            >
              <Plus data-icon="inline-start" />
              Add note
            </Button>
          )}

          <PayerPicker
            participants={participants}
            meId={me.id}
            amountCents={amountCents}
            currency={currency}
            value={values.payer}
            onChange={(p) => set('payer', p)}
          />

          <SplitEditor
            participants={participants}
            meId={me.id}
            amountCents={amountCents}
            currency={currency}
            value={values.split}
            onChange={(sp) => set('split', sp)}
          />
        </FieldGroup>
      </div>

      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {!online ? (
          <FieldDescription className="flex items-center justify-center gap-1.5 text-center">
            <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
            {isEdit
              ? 'You’re offline — viewing only.'
              : 'You’re offline — save a draft and add it when you’re back online.'}
          </FieldDescription>
        ) : null}
        <Button
          className="h-12 w-full rounded-full"
          disabled={(isEdit && !online) || saving}
          onClick={handleSave}
        >
          {saving ? <Spinner data-icon="inline-start" /> : null}
          {isEdit
            ? 'Save changes'
            : savesAsDraft
              ? 'Save draft'
              : draft
                ? 'Add expense'
                : 'Save'}
        </Button>
        {draft ? (
          <Button
            variant="ghost"
            className="h-12 w-full rounded-full text-muted-foreground"
            onClick={discardDraft}
          >
            <Trash2 data-icon="inline-start" />
            Discard draft
          </Button>
        ) : null}
        {expense ? (
          <>
            <Button
              variant="destructive"
              className="h-12 w-full rounded-full"
              disabled={!online || deleteExpense.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 data-icon="inline-start" />
              Delete expense
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{expense.description}" will be removed and everyone's balances will update.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    className="rounded-full"
                    disabled={deleteExpense.isPending}
                    onClick={handleDelete}
                  >
                    {deleteExpense.isPending ? <Spinner data-icon="inline-start" /> : null}
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </SheetFooter>
    </>
  );
}

function ScanningCard({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3 rounded-[20px] border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Spinner />
        Reading receipt…
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto rounded-full"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-3 w-2/3 rounded-full" />
        <Skeleton className="h-3 w-1/2 rounded-full" />
        <Skeleton className="h-3 w-3/4 rounded-full" />
      </div>
    </div>
  );
}

function ScanReviewBanner({
  review,
  onRescan,
  rescanDisabled,
  onDismiss,
}: {
  review: ScanReview;
  onRescan: () => void;
  rescanDisabled: boolean;
  onDismiss: () => void;
}) {
  const low = review.confidence === 'low';
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-[20px] border border-signal/40 bg-signal/10 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden="true" />
        <p className="flex-1 font-medium">Check the amounts before saving</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mt-1 -mr-1 rounded-full"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      {low ? (
        <p className="font-medium text-owing">
          Low confidence — the photo was hard to read. Double-check every field.
        </p>
      ) : review.confidence === 'medium' ? (
        <p className="text-muted-foreground">Some values were hard to read.</p>
      ) : null}
      {review.warnings.length > 0 || review.remark ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          {review.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
          {review.remark ? <li>{review.remark}</li> : null}
        </ul>
      ) : null}
      <p className="text-muted-foreground">
        Pick who paid and how to split, then save.
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1.5 py-0 align-baseline"
          disabled={rescanDisabled}
          onClick={onRescan}
        >
          Scan again
        </Button>
      </p>
    </div>
  );
}

/** "Draft restored · Discard" / repeat + revalidation notes at the top of the form. */
function FormNotice({
  title,
  notes,
  onDiscard,
}: {
  title: string | null;
  notes: string[];
  onDiscard?: () => void;
}) {
  const warn = notes.length > 0;
  return (
    <div
      role="status"
      className={
        warn
          ? 'flex flex-col gap-1.5 rounded-[20px] border border-signal/40 bg-signal/10 px-4 py-3 text-sm'
          : 'flex flex-col gap-1.5 rounded-[20px] bg-secondary px-4 py-3 text-sm'
      }
    >
      <div className="flex min-h-7 items-center gap-2">
        {warn ? (
          <TriangleAlert className="size-4 shrink-0 text-signal" aria-hidden="true" />
        ) : null}
        <p className="flex-1 font-medium">{title}</p>
        {onDiscard ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-1 -mr-2 rounded-full"
            onClick={onDiscard}
          >
            Discard
          </Button>
        ) : null}
      </div>
      {warn ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
