import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  ChevronDown,
  CloudOff,
  EllipsisVertical,
  History,
  Info,
  Plus,
  Repeat2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import { currencyPickerOptions } from '@/components/common/currency-options';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CATEGORIES, CATEGORY_META } from '@/lib/categories';
import {
  errorMessage,
  isConflict,
  isKeyReused,
  isRemovedSince,
  scanErrorMessage,
  scanReceipt,
} from '@/lib/api';
import { createClientKeyTracker, newClientKey } from '@/lib/client-key';
import { currentDrafts, removeDraft, saveAutosave, saveDraft, useDrafts } from '@/lib/draft-store';
import { autosaveScopeKey, createDraft, type Draft, type DraftsState } from '@/lib/drafts';
import {
  applyScope,
  checkFormValues,
  emptyFormValues,
  formSummary,
  formValuesFromExpense,
  participantIdsFor,
  revalidateFormValues,
  sameFormValues,
  scopeChoiceOf,
  userById,
  type ExpenseFormValues,
  type FormErrors,
  type ScopeChoice,
} from '@/lib/expense-form';
import { downscaleImage, partialPrefill, receiptPrefill } from '@/lib/receipt';
import {
  applyScanEvent,
  INITIAL_PROGRESS,
  modelLabel,
  type ScanProgress,
} from '@/lib/scan-progress';
import {
  CADENCE_OPTIONS,
  cadenceLabel,
  formValuesFromRule,
  repeatPlan,
  shortDate,
  templateFromForm,
} from '@/lib/recurring';
import { buildRepeatPrefill } from '@/lib/repeat';
import { formatMoney, isCanonicalAmount } from '@/lib/money';
import { prefersReducedMotion, shakeInvalidFields } from '@/lib/motion';
import {
  SYNC_KEY,
  useAddOccurrence,
  useCreateExpense,
  useCreateRecurring,
  useDeleteExpense,
  useSyncData,
  useUpdateExpense,
  useUpdateRecurring,
} from '@/lib/queries';
import type {
  Cadence,
  Category,
  Expense,
  PendingOccurrence,
  RecurringRule,
  SyncData,
  User,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { DiscardChangesDialog, useCloseGuard, type CloseGuard } from './close-guard';
import ExpenseHistorySheet from './ExpenseHistorySheet';
import { centsToInput, currencySymbol, relativeDay, todayISO } from './money-input';
import { PayerPicker } from './PayerPicker';
import { FillFlash, ScanningCard, ScanReviewBanner, type ScanReview } from './ReceiptScan';
import { ScopeField } from './ScopePicker';
import { SplitEditor } from './SplitEditor';
import { splitStateFromExpense } from './split-state';

export interface ExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group to add the expense to; null = no group (a direct expense, or none chosen yet). */
  groupId: number | null;
  /** Present = edit mode. */
  expense?: Expense;
  /** Preselect this friend for a direct expense. Omit (with groupId null) to ask first. */
  friendId?: number;
  /** Present = add a copy of this expense dated today ("Repeat"), as a new expense. */
  repeatOf?: Expense;
  /** Present = review a saved draft (its own scope wins over groupId/friendId). */
  draftId?: string;
  /** Present = review a due recurring bill, then add it (marks it added). */
  occurrence?: PendingOccurrence;
  /** Present = edit a recurring bill's template and schedule. */
  rule?: RecurringRule;
  /** New expense only: open with Repeat preselected (the "New recurring bill" entry). */
  defaultRepeat?: Cadence;
}

export default function ExpenseForm({
  open,
  onOpenChange,
  groupId,
  expense,
  friendId,
  repeatOf,
  draftId,
  occurrence,
  rule,
  defaultRepeat,
}: ExpenseFormProps) {
  const { guard, onSheetOpenChange, confirm } = useCloseGuard(onOpenChange);
  return (
    <>
      <Sheet open={open} onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-card"
        >
          {/* Mounted only while the sheet is open, so state resets between uses
              (in-progress new expenses survive via the draft autosave). */}
          <FormBody
            onOpenChange={onOpenChange}
            groupId={groupId}
            expense={expense}
            friendId={friendId}
            repeatOf={repeatOf}
            draftId={draftId}
            occurrence={occurrence}
            rule={rule}
            defaultRepeat={defaultRepeat}
            guard={guard}
          />
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog {...confirm} description="Your edits haven’t been saved." />
    </>
  );
}

type FormMode =
  | { kind: 'new' }
  | { kind: 'edit'; expense: Expense }
  | { kind: 'repeat'; expense: Expense }
  | { kind: 'draft'; draftId: string }
  | { kind: 'occurrence'; occurrence: PendingOccurrence }
  | { kind: 'rule'; rule: RecurringRule };

const TITLES: Record<FormMode['kind'], string> = {
  new: 'Add expense',
  edit: 'Edit expense',
  repeat: 'Repeat expense',
  draft: 'Review draft',
  occurrence: 'Add due bill',
  rule: 'Edit recurring bill',
};

function FormBody({
  onOpenChange,
  groupId,
  expense,
  friendId,
  repeatOf: repeatProp,
  draftId,
  occurrence,
  rule,
  defaultRepeat,
  guard,
}: Omit<ExpenseFormProps, 'open'> & { guard: CloseGuard }) {
  const { data: sync } = useSyncData();
  const drafts = useDrafts(sync?.me.id);
  // "Repeat" turns this sheet from editing an expense into adding a copy of it.
  const [repeatOf, setRepeatOf] = useState<Expense | null>(repeatProp ?? null);
  const mode: FormMode = repeatOf
    ? { kind: 'repeat', expense: repeatOf }
    : draftId !== undefined
      ? { kind: 'draft', draftId }
      : occurrence
        ? { kind: 'occurrence', occurrence }
        : rule
          ? { kind: 'rule', rule }
          : expense
            ? { kind: 'edit', expense }
            : { kind: 'new' };
  if (!sync || !drafts) {
    return (
      <>
        <SheetHeader className="pr-14">
          <SheetTitle className="text-xl">{TITLES[mode.kind]}</SheetTitle>
        </SheetHeader>
        {!sync ? (
          <FieldDescription className="px-4 pb-6">
            Your data hasn't loaded yet — try again in a moment.
          </FieldDescription>
        ) : (
          <div className="flex justify-center px-4 pb-8">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        )}
      </>
    );
  }
  return (
    <FormFields
      key={mode.kind}
      sync={sync}
      drafts={drafts}
      mode={mode}
      onOpenChange={onOpenChange}
      groupId={groupId}
      friendId={friendId}
      onRepeat={setRepeatOf}
      defaultRepeat={defaultRepeat}
      guard={guard}
    />
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
  /** Edit mode: no split method on record — opened as exact amounts. */
  legacySplit: boolean;
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
    legacySplit: false,
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
        legacySplit: splitStateFromExpense(expense, participantIds).legacy,
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
    case 'occurrence': {
      const rule = sync.recurring?.rules.find((r) => r.id === mode.occurrence.ruleId);
      if (!rule) {
        return {
          ...base,
          values: emptyFormValues(sync, { groupId: null }),
          blocking: 'This recurring bill was deleted.',
        };
      }
      const rv = formValuesFromRule(rule, sync, mode.occurrence.dueDate);
      return { ...base, values: rv.values, notes: rv.notes, blocking: rv.blocking };
    }
    case 'rule': {
      const rv = formValuesFromRule(mode.rule, sync, mode.rule.nextDue);
      return { ...base, values: rv.values, notes: rv.notes, blocking: rv.blocking };
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

/** Which failing rule maps to which control, in on-screen order. */
const FIELD_ORDER = ['scope', 'amount', 'description', 'split', 'date'] as const;
type FieldKey = (typeof FIELD_ORDER)[number];

function invalidFields(errors: FormErrors): FieldKey[] {
  return FIELD_ORDER.filter((k) =>
    k === 'split' ? errors.paid !== null || errors.split !== null : errors[k] !== null,
  );
}

function FormFields({
  sync,
  drafts,
  mode,
  onOpenChange,
  groupId: groupIdProp,
  friendId,
  onRepeat,
  defaultRepeat,
  guard,
}: {
  sync: SyncData;
  drafts: DraftsState;
  mode: FormMode;
  onOpenChange: (open: boolean) => void;
  groupId: number | null;
  friendId?: number;
  onRepeat: (expense: Expense) => void;
  defaultRepeat?: Cadence;
  guard: CloseGuard;
}) {
  const qc = useQueryClient();
  const online = useOnline();
  const uid = useId();
  const ids = useMemo(
    () => ({
      scope: `${uid}-scope`,
      amount: `${uid}-amount`,
      description: `${uid}-description`,
      split: `${uid}-split`,
      date: `${uid}-date`,
      panel: `${uid}-panel`,
      err: (k: FieldKey) => `${uid}-${k}-error`,
    }),
    [uid],
  );
  const keyFor = useRef(createClientKeyTracker()).current;
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();
  const createRecurring = useCreateRecurring();
  const updateRecurring = useUpdateRecurring();
  const addOccurrence = useAddOccurrence();

  const me = sync.me;
  const [init] = useState(() => initialForm(mode, sync, drafts, groupIdProp, friendId));
  const [values, setValues] = useState<ExpenseFormValues>(init.values);
  const [notices, setNotices] = useState(init.notes);
  const [restored, setRestored] = useState(init.restored);
  const [legacySplit, setLegacySplit] = useState(init.legacySplit);
  const [currencyNotice, setCurrencyNotice] = useState<string | null>(null);
  const set = <K extends keyof ExpenseFormValues>(key: K, value: ExpenseFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const expense = mode.kind === 'edit' ? mode.expense : undefined;
  const isEdit = expense !== undefined;
  /** Edits and recurring bills keep their group / friend; new expenses choose one. */
  const fixedScope = isEdit || mode.kind === 'occurrence' || mode.kind === 'rule';
  /** New expenses, repeats and drafts autosave to this device (and save offline as drafts). */
  const autosaves = mode.kind === 'new' || mode.kind === 'repeat' || mode.kind === 'draft';
  // "Repeat" for a new expense (or a recurring bill's cadence while editing it).
  const [repeat, setRepeat] = useState<Cadence | 'none'>(
    mode.kind === 'rule'
      ? mode.rule.cadence
      : mode.kind === 'new' && defaultRepeat
        ? defaultRepeat
        : 'none',
  );
  const offersRepeat = mode.kind === 'new' || mode.kind === 'rule';
  const { groupId, currency } = values;
  const group = groupId !== null ? (sync.groups.find((g) => g.id === groupId) ?? null) : null;
  const scope = scopeChoiceOf(values);

  const [attempted, setAttempted] = useState(false);
  const [submits, setSubmits] = useState(0);
  // The first failing field, focused once the submit's render is on screen.
  const focusPending = useRef<FieldKey | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
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
    if (!autosaves) return;
    if (!dirty.current && sameFormValues(values, init.values)) return;
    dirty.current = true;
    const t = setTimeout(() => persist(), 400);
    return () => clearTimeout(t);
  }, [values, init.values, autosaves]);
  useEffect(() => () => persist(), []);

  // --- Unsaved-edit protection: edits of things that don't autosave (an
  // expense, a recurring bill, a due bill under review) ask before closing.
  const guarded = !autosaves;
  const unsaved =
    guarded &&
    (!sameFormValues(values, init.values) ||
      (mode.kind === 'rule' && repeat !== mode.rule.cadence));
  const unsavedRef = useRef(unsaved);
  useLayoutEffect(() => {
    unsavedRef.current = unsaved;
  });
  useLayoutEffect(() => {
    guard(() => unsavedRef.current && !finished.current);
    return () => guard(null);
  }, [guard]);

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
    setCurrencyNotice(null);
    if (init.scopeKey !== null) saveAutosave(me.id, init.scopeKey, null);
  };

  const changeScope = (choice: ScopeChoice) => {
    const next = applyScope(values, choice, sync);
    setValues(next.values);
    setCurrencyNotice(next.currencyNotice);
  };

  // Receipt scanning (new expenses only). The scan only prefills fields — the
  // user still picks payer/split and has to press Add expense.
  const canScan = mode.kind === 'new' && sync.features?.receiptScan === true;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanAbort = useRef<AbortController | null>(null);
  const [scanning, setScanning] = useState(false);
  // Object URL of the photo being read, shown under the scan line.
  const [scanPhoto, setScanPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!scanPhoto) return;
    return () => URL.revokeObjectURL(scanPhoto);
  }, [scanPhoto]);
  const [scanProgress, setScanProgress] = useState<ScanProgress>(INITIAL_PROGRESS);
  const [scanReview, setScanReview] = useState<ScanReview | null>(null);
  // Per-field counters: bumping one replays that field's "just filled" wash.
  const [filled, setFilled] = useState({ amount: 0, description: 0, date: 0 });
  useEffect(() => () => scanAbort.current?.abort(), []);

  const handleReceiptFile = async (file: File | undefined) => {
    if (!file) return;
    scanAbort.current?.abort();
    const ctrl = new AbortController();
    scanAbort.current = ctrl;
    setScanning(true);
    setScanPhoto(URL.createObjectURL(file));
    setScanReview(null);
    setScanProgress(INITIAL_PROGRESS);
    // Fixed for this scan: what the form was in when the photo was taken.
    const formCurrency = currency;
    const canChangeCurrency = group === null;
    let escalatedTo: string | null = null;
    // Fill fields as they stream in, flashing each one that changes.
    const applied: { description?: string; date?: string; amount?: string } = {};
    const fill = (next: {
      description?: string;
      date?: string;
      currency?: string;
      amountCents?: number;
    }) => {
      const cur = next.currency ?? formCurrency;
      const amount =
        next.amountCents !== undefined ? centsToInput(next.amountCents, cur) : undefined;
      const bump = { amount: 0, description: 0, date: 0 };
      if (next.description && next.description !== applied.description) {
        applied.description = next.description;
        bump.description = 1;
      }
      if (next.date && next.date !== applied.date) {
        applied.date = next.date;
        bump.date = 1;
      }
      if (amount && amount !== applied.amount) {
        applied.amount = amount;
        bump.amount = 1;
      }
      if (!bump.amount && !bump.description && !bump.date && !next.currency) return;
      setValues((prev) => ({
        ...prev,
        ...(bump.description ? { description: next.description! } : {}),
        ...(bump.date ? { date: next.date! } : {}),
        ...(next.currency ? { currency: next.currency } : {}),
        ...(bump.amount ? { amountRaw: amount! } : {}),
      }));
      setFilled((f) => ({
        amount: f.amount + bump.amount,
        description: f.description + bump.description,
        date: f.date + bump.date,
      }));
    };
    try {
      let image: string;
      try {
        image = await downscaleImage(file);
      } catch {
        toast.error("Couldn't open that photo — try another one.");
        return;
      }
      if (ctrl.signal.aborted) return;
      const result = await scanReceipt(image, {
        currency: formCurrency,
        locale: navigator.language,
        signal: ctrl.signal,
        onEvent: (event) => {
          if (ctrl.signal.aborted) return;
          if (event.type === 'status' && event.stage === 'escalating') {
            escalatedTo = event.model ?? null;
          }
          if (event.type === 'partial') {
            fill(partialPrefill(event.fields, formCurrency, canChangeCurrency));
          }
          setScanProgress((p) => applyScanEvent(p, event));
        },
      });
      if (ctrl.signal.aborted) return;
      const { draft, warnings } = result;
      const p = receiptPrefill(draft, formCurrency, canChangeCurrency);
      fill({
        ...(p.description ? { description: p.description } : {}),
        ...(p.date ? { date: p.date } : {}),
        ...(p.currency ? { currency: p.currency } : {}),
        ...(p.amountCents !== null ? { amountCents: p.amountCents } : {}),
      });
      setValues((prev) => ({
        ...prev,
        // A partial fill of the amount that the final read didn't confirm
        // (e.g. it turned out to be another currency) is taken back out.
        ...(p.amountCents === null && applied.amount === prev.amountRaw ? { amountRaw: '' } : {}),
        category: p.category,
        ...(p.notes ? { notes: p.notes, showNotes: true } : {}),
      }));
      const label = modelLabel(result.model);
      setScanReview({
        // The foreign-total panel already says it; don't repeat it as a bullet.
        warnings: [...(p.currencyNotice && !p.foreignTotal ? [p.currencyNotice] : []), ...warnings],
        confidence: draft.confidence,
        remark: draft.notes,
        byline: result.escalated
          ? `Re-checked with ${modelLabel(escalatedTo ?? result.model)}`
          : `Scanned with ${label}`,
        foreignTotal: p.foreignTotal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      toast.error(scanErrorMessage(err));
    } finally {
      if (scanAbort.current === ctrl) {
        scanAbort.current = null;
        setScanning(false);
        setScanPhoto(null);
      }
    }
  };

  const cancelScan = () => {
    scanAbort.current?.abort();
    scanAbort.current = null;
    setScanning(false);
    setScanPhoto(null);
  };

  const participantIds = init.participantIds ?? participantIdsFor(values, sync);
  const participantKey = participantIds.join(',');
  const participants: User[] = useMemo(
    () => participantKey.split(',').filter(Boolean).map((id) => userById(sync, Number(id))),
    [sync, participantKey],
  );

  const check = checkFormValues(values, participants, me.id);
  const { amountCents } = check;
  const failing = invalidFields(check.errors);
  const shown = (k: FieldKey) => attempted && failing.includes(k);
  const errorText = (k: FieldKey): string | null =>
    k === 'split' ? (check.errors.paid ?? check.errors.split) : check.errors[k];
  const describe = (k: FieldKey) => (shown(k) ? ids.err(k) : undefined);

  // Move to the first failing field once it's rendered (editors expanded).
  useEffect(() => {
    const pending = focusPending.current;
    if (!pending) return;
    focusPending.current = null;
    let el = document.getElementById(
      pending === 'split' ? ids.err('split') : ids[pending],
    );
    if (pending === 'split') {
      const inPanel = document.getElementById(ids.panel);
      el =
        inPanel?.querySelector<HTMLElement>('input[aria-invalid], input') ??
        document.getElementById(ids.split);
    }
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [submits, ids]);

  // P3: keep the selected category chip in view (on open, and on change).
  const categoryRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = categoryRow.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed=true]');
    if (!row || !chip) return;
    const target = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
  }, [values.category]);

  const saving =
    createExpense.isPending ||
    updateExpense.isPending ||
    createRecurring.isPending ||
    updateRecurring.isPending ||
    addOccurrence.isPending;
  const draft = init.draft;
  /** Offline, a new expense (or a draft under review) is kept as a draft. */
  const savesAsDraft = !online && autosaves;
  const today = todayISO();
  const plan = repeat !== 'none' && values.date ? repeatPlan(values.date, repeat, today) : null;

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    const input = check.input;
    if (!input) {
      setSubmits((n) => n + 1);
      const first = failing[0] ?? null;
      if (failing.includes('split')) setSplitOpen(true);
      focusPending.current = first;
      // A supplement only: the messages and focus carry the feedback.
      shakeInvalidFields(e.currentTarget);
      return;
    }
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
        finished.current = true;
        if (draft) removeDraft(me.id, draft.id);
        toast(isEdit ? 'Expense updated' : 'Expense added');
        onOpenChange(false);
      },
      onError: (err: Error) => {
        // Not saved after all: keep autosaving what's on screen.
        finished.current = false;
        if (draft && isKeyReused(err)) {
          // An earlier (ambiguous) save of this draft did go through, and the
          // draft was edited since. Keep the draft and these edits; the user
          // edits the recorded expense instead.
          toast.error('This draft was already added — open it to edit.');
          void qc.invalidateQueries({ queryKey: SYNC_KEY });
          return;
        }
        toast.error(errorMessage(err));
        if (isRemovedSince(err)) void qc.invalidateQueries({ queryKey: SYNC_KEY });
        if (isConflict(err)) {
          // Our copy is outdated: close and pull the latest so a reopen
          // starts from what the other person saved.
          void qc.invalidateQueries({ queryKey: SYNC_KEY });
          finished.current = true;
          onOpenChange(false);
        }
      },
    };
    const failed = (err: Error) => {
      finished.current = false;
      toast.error(errorMessage(err));
    };
    const done = (message: string) => () => {
      finished.current = true;
      toast(message);
      onOpenChange(false);
    };
    if (mode.kind === 'occurrence') {
      addOccurrence.mutate(
        {
          occurrenceId: mode.occurrence.id,
          expense: {
            groupId: input.groupId,
            description: input.description,
            amountCents: input.amountCents,
            currency: input.currency,
            date: input.date,
            category: input.category,
            notes: input.notes,
            shares: input.shares,
            ...(input.split ? { split: input.split } : {}),
          },
        },
        { onSuccess: done('Expense added'), onError: failed },
      );
      return;
    }
    if (mode.kind === 'rule') {
      updateRecurring.mutate(
        {
          id: mode.rule.id,
          template: templateFromForm(values, input, participantIds),
          cadence: repeat === 'none' ? mode.rule.cadence : repeat,
          // A moved "next due" date re-anchors the schedule on it.
          ...(values.date !== init.values.date ? { anchorDate: values.date } : {}),
        },
        { onSuccess: done('Recurring bill updated'), onError: failed },
      );
      return;
    }
    if (mode.kind === 'new' && repeat !== 'none' && plan) {
      const cadence = repeat;
      const body = {
        groupId: input.groupId,
        friendId: input.groupId === null ? values.friendId : null,
        template: templateFromForm(values, input, participantIds),
        cadence,
        anchorDate: input.date,
        addFirst: plan.addFirst,
      };
      finish();
      createRecurring.mutate(
        { ...body, clientKey: keyFor(body) },
        {
          onSuccess: done(
            plan.addFirst
              ? `Expense added · repeats ${cadenceLabel(cadence).toLowerCase()}`
              : `Recurring bill set up — first due ${shortDate(plan.firstDue, today)}`,
          ),
          onError: failed,
        },
      );
      return;
    }
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
        finished.current = true;
        toast('Expense deleted');
        setConfirmOpen(false);
        onOpenChange(false);
      },
      onError: (err: Error) => toast.error(errorMessage(err)),
    });
  };

  const [historyOpen, setHistoryOpen] = useState(false);
  const menu =
    mode.kind === 'edit' || draft ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 rounded-full"
              aria-label={isEdit ? 'Expense options' : 'Draft options'}
            />
          }
        >
          <EllipsisVertical aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          {expense ? (
            <>
              <DropdownMenuItem className="min-h-11 px-3" onClick={() => setHistoryOpen(true)}>
                <History aria-hidden="true" /> History
              </DropdownMenuItem>
              {!expense.isPayment ? (
                <DropdownMenuItem className="min-h-11 px-3" onClick={() => onRepeat(expense)}>
                  <Repeat2 aria-hidden="true" /> Repeat as a new expense
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="min-h-11 px-3"
                disabled={!online || deleteExpense.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 aria-hidden="true" /> Delete expense
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem variant="destructive" className="min-h-11 px-3" onClick={discardDraft}>
              <Trash2 aria-hidden="true" /> Discard draft
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  const header = (
    <SheetHeader className="flex-row items-center gap-2 pr-14">
      <SheetTitle className="text-xl">
        {mode.kind === 'new' && defaultRepeat ? 'New recurring bill' : TITLES[mode.kind]}
      </SheetTitle>
      {menu ? <div className="ml-auto">{menu}</div> : null}
    </SheetHeader>
  );

  if (init.blocking) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          <FieldDescription>{init.blocking}</FieldDescription>
          {draft ? (
            <Button variant="outline" size="pill" className="w-full" onClick={discardDraft}>
              <Trash2 data-icon="inline-start" />
              Discard draft
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  if (groupId !== null && !group) {
    return (
      <>
        {header}
        <FieldDescription className="px-4 pb-6">
          This group isn't available anymore.
        </FieldDescription>
      </>
    );
  }

  const summary = formSummary(values, participants, me.id, amountCents);
  const dayLabel = values.date ? relativeDay(values.date, today) : null;
  const errorCount = attempted ? failing.length : 0;
  const notice =
    restored || notices.length > 0 || mode.kind === 'repeat' || mode.kind === 'occurrence';

  return (
    <>
      {header}
      {expense ? (
        <>
          <ExpenseHistorySheet
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            expense={expense}
            // The form holds the pre-restore values: close it so nothing stale is saved.
            onRestored={() => {
              finished.current = true;
              onOpenChange(false);
            }}
          />
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
                <AlertDialogDescription>
                  “{expense.description}” will be removed and everyone’s balances will update.
                  You can restore it from Recently deleted.
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
      <form noValidate onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <FieldGroup className="gap-6 pb-4">
            {errorCount > 1 ? (
              <div
                key={submits}
                role="alert"
                className="flex flex-col gap-1 rounded-panel bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                <p className="font-medium">Fix {errorCount} things to save this expense:</p>
                <ul className="flex list-disc flex-col gap-0.5 pl-5">
                  {failing.map((k) => (
                    <li key={k}>{errorText(k)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {notice ? (
              <FormNotice
                title={
                  restored
                    ? 'Draft restored'
                    : mode.kind === 'repeat'
                      ? 'Repeating with today’s date'
                      : mode.kind === 'occurrence'
                        ? `Due ${shortDate(mode.occurrence.dueDate, today)} — check it, then add`
                        : mode.kind === 'rule'
                          ? 'Some people changed since this bill was set up'
                          : 'Some things changed since this draft'
                }
                notes={notices}
                onDiscard={restored ? discardRestored : undefined}
              />
            ) : null}

            {/* 1 · Where it goes */}
            <Field data-invalid={shown('scope')}>
              <span className="text-sm leading-snug font-medium">
                {fixedScope ? 'Expense in' : 'Add to'}
              </span>
              <ScopeField
                id={ids.scope}
                sync={sync}
                value={scope}
                onChange={changeScope}
                readOnly={fixedScope}
                invalid={shown('scope')}
                describedBy={describe('scope')}
              />
              {shown('scope') ? (
                <FieldDescription id={ids.err('scope')} className="text-destructive">
                  {check.errors.scope}
                </FieldDescription>
              ) : null}
              {currencyNotice ? (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-panel bg-warning/10 px-3 py-2 text-sm"
                >
                  <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="flex-1">{currencyNotice}</span>
                </p>
              ) : null}
            </Field>

            {/* 2 · Amount and description */}
            <div className="flex flex-col gap-4">
              <Field data-invalid={shown('amount')}>
                <FieldLabel htmlFor={ids.amount}>Amount</FieldLabel>
                <div className="relative">
                  <InputGroup className="h-14 rounded-full">
                    <InputGroupAddon className="pl-5">
                      <InputGroupText className="text-xl text-foreground">
                        {currencySymbol(currency)}
                      </InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      id={ids.amount}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={centsToInput(0, currency)}
                      value={values.amountRaw}
                      onChange={(e) => set('amountRaw', e.target.value)}
                      aria-invalid={shown('amount') || undefined}
                      aria-describedby={describe('amount')}
                      className="text-2xl font-medium tabular-nums md:text-2xl"
                    />
                    <InputGroupAddon align="inline-end" className="pr-2">
                      {group || fixedScope ? (
                        <InputGroupText className="pr-3">{currency}</InputGroupText>
                      ) : (
                        <PickerSelect
                          title="Currency"
                          aria-label="Currency"
                          className="h-11 w-auto gap-1 border-0 bg-muted px-3 font-medium"
                          value={currency}
                          onValueChange={(v) => {
                            set('currency', v);
                            setCurrencyNotice(null);
                          }}
                          options={currencyPickerOptions([me.defaultCurrency, currency])}
                          searchable
                        />
                      )}
                    </InputGroupAddon>
                  </InputGroup>
                  <FillFlash n={filled.amount} />
                </div>
                {shown('amount') ? (
                  <FieldDescription id={ids.err('amount')} className="text-destructive">
                    {check.errors.amount}
                  </FieldDescription>
                ) : amountCents !== null && !isCanonicalAmount(values.amountRaw) ? (
                  // Anything but a plain "12.50" (math, "12,50", grouping) shows
                  // how it was read, so a misparse can't slip through unseen.
                  <FieldDescription>= {formatMoney(amountCents, currency)}</FieldDescription>
                ) : null}
              </Field>

              <Field data-invalid={shown('description')}>
                <FieldLabel htmlFor={ids.description}>Description</FieldLabel>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Input
                      id={ids.description}
                      value={values.description}
                      onChange={(e) => set('description', e.target.value)}
                      maxLength={200}
                      placeholder="Dinner, taxi, rent…"
                      aria-invalid={shown('description') || undefined}
                      aria-describedby={describe('description')}
                      className="h-11 flex-1 rounded-full px-4"
                    />
                    <FillFlash n={filled.description} />
                  </div>
                  {canScan && online && !scanning ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="pill"
                      className="shrink-0 px-4"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Camera data-icon="inline-start" aria-hidden="true" />
                      Scan
                      <span className="sr-only"> a receipt</span>
                    </Button>
                  ) : null}
                </div>
                {shown('description') ? (
                  <FieldDescription id={ids.err('description')} className="text-destructive">
                    {check.errors.description}
                  </FieldDescription>
                ) : null}
              </Field>

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
                    <ScanningCard photo={scanPhoto} progress={scanProgress} onCancel={cancelScan} />
                  ) : scanReview ? (
                    <ScanReviewBanner
                      review={scanReview}
                      formCurrency={currency}
                      amountRaw={values.amountRaw}
                      onAmountChange={(raw) => set('amountRaw', raw)}
                      onRescan={() => fileInputRef.current?.click()}
                      rescanDisabled={!online}
                      onDismiss={() => setScanReview(null)}
                    />
                  ) : null}
                </>
              ) : null}
            </div>

            {/* 3 · Who paid and how it's split — one line until opened */}
            <Field data-invalid={shown('split')}>
              <button
                id={ids.split}
                type="button"
                aria-expanded={splitOpen}
                aria-controls={ids.panel}
                aria-invalid={shown('split') || undefined}
                aria-describedby={describe('split')}
                disabled={scope === null}
                onClick={() => setSplitOpen((o) => !o)}
                className={cn(
                  'pressable flex min-h-14 w-full items-center gap-3 rounded-panel bg-muted/60 px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-focus-ring disabled:opacity-60',
                  shown('split') && 'ring-3 ring-destructive/30',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm text-muted-foreground">Paid by and split</span>
                  {scope === null ? (
                    <span className="font-medium">Choose where it goes first</span>
                  ) : (
                    <span className="font-medium break-words">
                      {summary.paidBy} · {summary.split}
                      {summary.detail ? (
                        <span className="text-muted-foreground"> · {summary.detail}</span>
                      ) : null}
                    </span>
                  )}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'size-5 shrink-0 text-muted-foreground transition-transform duration-(--dur-base)',
                    splitOpen && 'rotate-180',
                  )}
                />
              </button>
              {shown('split') && !splitOpen ? (
                <FieldDescription id={ids.err('split')} className="text-destructive">
                  {errorText('split')}
                </FieldDescription>
              ) : null}
              {splitOpen && scope !== null ? (
                <div
                  id={ids.panel}
                  className="flex flex-col gap-6 rounded-panel border border-border px-4 py-4"
                >
                  <PayerPicker
                    participants={participants}
                    meId={me.id}
                    amountCents={amountCents}
                    currency={currency}
                    value={values.payer}
                    onChange={(p) => set('payer', p)}
                    showErrors={attempted}
                    errorId={check.errors.paid ? ids.err('split') : undefined}
                  />
                  <SplitEditor
                    participants={participants}
                    meId={me.id}
                    amountCents={amountCents}
                    currency={currency}
                    value={values.split}
                    onChange={(sp) => {
                      set('split', sp);
                      if (sp.mode !== 'unequal') setLegacySplit(false);
                    }}
                    showErrors={attempted}
                    legacy={legacySplit}
                    errorId={check.errors.paid ? undefined : ids.err('split')}
                  />
                </div>
              ) : null}
            </Field>

            {/* 4 · Additional details */}
            <section aria-labelledby={`${uid}-details`} className="flex flex-col gap-5">
              <h3 id={`${uid}-details`} className="text-base font-medium tracking-tight">
                Additional details
              </h3>
              <Field data-invalid={shown('date')}>
                <FieldLabel htmlFor={ids.date}>
                  {mode.kind === 'rule' ? 'Next due' : 'Date'}
                </FieldLabel>
                <div className="relative">
                  <InputGroup className="h-11 rounded-full">
                    <InputGroupInput
                      id={ids.date}
                      type="date"
                      value={values.date}
                      onChange={(e) => set('date', e.target.value)}
                      aria-invalid={shown('date') || undefined}
                      aria-describedby={describe('date')}
                      className="pl-4"
                    />
                    {dayLabel ? (
                      <InputGroupAddon align="inline-end" className="pr-4">
                        <InputGroupText>{dayLabel}</InputGroupText>
                      </InputGroupAddon>
                    ) : null}
                  </InputGroup>
                  <FillFlash n={filled.date} />
                </div>
                {shown('date') ? (
                  <FieldDescription id={ids.err('date')} className="text-destructive">
                    {check.errors.date}
                  </FieldDescription>
                ) : null}
              </Field>

              <Field>
                <FieldLabel id={`${uid}-category`}>Category</FieldLabel>
                <div ref={categoryRow} className="-mx-4 w-[calc(100%+2rem)]! overflow-x-auto px-4 pb-1">
                  <ToggleGroup
                    value={[values.category]}
                    onValueChange={(v) => {
                      if (v[0]) set('category', v[0] as Category);
                    }}
                    className="w-max justify-start"
                    aria-labelledby={`${uid}-category`}
                  >
                    {CATEGORIES.map((c) => (
                      <ToggleGroupItem
                        key={c}
                        value={c}
                        variant="outline"
                        className="h-11 shrink-0 gap-1.5 rounded-full px-4 aria-pressed:border-primary aria-pressed:bg-muted"
                      >
                        <CategoryIcon category={c} />
                        {CATEGORY_META[c].label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </Field>

              {offersRepeat ? (
                <RepeatField
                  value={repeat}
                  onChange={setRepeat}
                  editingRule={mode.kind === 'rule'}
                  offline={!online}
                  plan={plan}
                  today={today}
                />
              ) : null}

              {values.showNotes ? (
                <Field>
                  <FieldLabel htmlFor={`${uid}-notes`}>Notes</FieldLabel>
                  <Textarea
                    id={`${uid}-notes`}
                    value={values.notes}
                    onChange={(e) => set('notes', e.target.value)}
                    maxLength={1000}
                    placeholder="Anything worth remembering"
                    className="rounded-panel px-4"
                  />
                </Field>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 self-start rounded-full"
                  onClick={() => set('showNotes', true)}
                >
                  <Plus data-icon="inline-start" />
                  Add note
                </Button>
              )}
            </section>
          </FieldGroup>
        </div>

        <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {!online ? (
            <FieldDescription className="flex items-center justify-center gap-1.5 text-center">
              <CloudOff className="size-3.5 shrink-0" aria-hidden="true" />
              {fixedScope
                ? 'You’re offline — viewing only.'
                : 'You’re offline — save a draft and add it when you’re back online.'}
            </FieldDescription>
          ) : null}
          <Button
            type="submit"
            size="cta"
            className="w-full"
            disabled={(fixedScope && !online) || saving}
          >
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {isEdit || mode.kind === 'rule'
              ? 'Save changes'
              : savesAsDraft
                ? 'Save draft'
                : mode.kind === 'new' && plan && !plan.addFirst
                  ? 'Set up recurring bill'
                  : 'Add expense'}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
}

/**
 * "Repeat" for a new expense (or a recurring bill's cadence): says plainly
 * what saving will do — nothing is ever added later without the user.
 */
function RepeatField({
  value,
  onChange,
  editingRule,
  offline,
  plan,
  today,
}: {
  value: Cadence | 'none';
  onChange: (value: Cadence | 'none') => void;
  editingRule: boolean;
  offline: boolean;
  plan: { addFirst: boolean; firstDue: string } | null;
  today: string;
}) {
  const id = useId();
  const hint = editingRule
    ? 'Each time it’s due, it waits in “Due to add” on Home for you to add or skip.'
    : offline
      ? 'Repeating needs a connection — offline, this saves as a one-off draft.'
      : plan === null
        ? null
        : plan.addFirst
          ? `Adds this now; next due ${shortDate(plan.firstDue, today)}. You confirm each one.`
          : `Nothing is added today — first due ${shortDate(plan.firstDue, today)}.`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>Repeat</FieldLabel>
      <PickerSelect
        id={id}
        title="Repeat"
        value={offline && !editingRule ? 'none' : value}
        disabled={offline}
        onValueChange={(v) => onChange(v as Cadence | 'none')}
        options={CADENCE_OPTIONS.filter((o) => !editingRule || o.value !== 'none')}
      />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
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
      className={cn(
        'flex flex-col gap-1.5 rounded-panel px-4 py-3 text-sm',
        warn ? 'bg-warning/10' : 'bg-muted/60',
      )}
    >
      <div className="flex min-h-7 items-center gap-2">
        {warn ? (
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
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
