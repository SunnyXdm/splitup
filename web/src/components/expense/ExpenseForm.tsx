import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CATEGORIES, CATEGORY_META } from '@/lib/categories';
import { formatMoney, parseAmountToCents } from '@/lib/money';
import { useCreateExpense, useDeleteExpense, useSyncData, useUpdateExpense } from '@/lib/queries';
import type { Category, Expense, ExpenseInput, ExpenseShare, SyncData, User } from '@/lib/types';
import { centsToInput, currencySymbol, todayISO } from './money-input';
import { PayerPicker, defaultPayerState, payerStateFromShares, resolvePaid, type PayerState } from './PayerPicker';
import { SplitEditor, defaultSplitState, resolveSplit, splitStateFromShares, type SplitState } from './SplitEditor';

export interface ExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group to add the expense to; null = non-group (1:1 with a friend). */
  groupId: number | null;
  /** Present = edit mode. */
  expense?: Expense;
  /** Preselect this friend for non-group expenses. */
  friendId?: number;
}

export default function ExpenseForm({
  open,
  onOpenChange,
  groupId,
  expense,
  friendId,
}: ExpenseFormProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl rounded-t-[28px]"
      >
        {/* Mounted only while the sheet is open, so state resets between uses. */}
        <FormBody
          onOpenChange={onOpenChange}
          groupId={groupId}
          expense={expense}
          friendId={friendId}
        />
      </SheetContent>
    </Sheet>
  );
}

function userById(sync: SyncData, id: number): User {
  return sync.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null };
}

function FormBody({
  onOpenChange,
  groupId,
  expense,
  friendId,
}: Omit<ExpenseFormProps, 'open'>) {
  const { data: sync } = useSyncData();
  const isEdit = expense !== undefined;
  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="text-xl">{isEdit ? 'Edit expense' : 'Add expense'}</SheetTitle>
      </SheetHeader>
      {sync ? (
        <FormFields
          sync={sync}
          onOpenChange={onOpenChange}
          groupId={groupId}
          expense={expense}
          friendId={friendId}
        />
      ) : (
        <FieldDescription className="px-4 pb-6">
          Your data hasn't loaded yet — try again in a moment.
        </FieldDescription>
      )}
    </>
  );
}

function FormFields({
  sync,
  onOpenChange,
  groupId,
  expense,
  friendId,
}: Omit<ExpenseFormProps, 'open'> & { sync: SyncData }) {
  const online = useOnline();
  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();

  const me = sync.me;
  const group = groupId !== null ? (sync.groups.find((g) => g.id === groupId) ?? null) : null;
  const isEdit = expense !== undefined;

  const initialFriendId = (() => {
    if (groupId !== null) return null;
    if (expense) return expense.shares.find((s) => s.userId !== me.id)?.userId ?? null;
    if (friendId !== undefined) return friendId;
    return sync.friendIds[0] ?? null;
  })();
  const initialParticipantIds = group
    ? group.memberIds
    : initialFriendId !== null
      ? [me.id, initialFriendId]
      : [me.id];

  const [activeFriendId, setActiveFriendId] = useState<number | null>(initialFriendId);
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountRaw, setAmountRaw] = useState(
    expense ? centsToInput(expense.amountCents, expense.currency) : '',
  );
  const [currency, setCurrency] = useState(
    expense?.currency ?? group?.currency ?? me.defaultCurrency,
  );
  const [date, setDate] = useState(expense?.date ?? todayISO());
  const [category, setCategory] = useState<Category>(expense?.category ?? 'general');
  const [notes, setNotes] = useState(expense?.notes ?? '');
  const [showNotes, setShowNotes] = useState(Boolean(expense?.notes));
  const [payer, setPayer] = useState<PayerState>(() =>
    expense ? payerStateFromShares(expense.shares, me.id, expense.currency) : defaultPayerState(me.id),
  );
  const [split, setSplit] = useState<SplitState>(() =>
    expense
      ? splitStateFromShares(expense.shares, initialParticipantIds, expense.currency)
      : defaultSplitState(initialParticipantIds),
  );
  const [attempted, setAttempted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const participants: User[] = useMemo(() => {
    if (group) return group.memberIds.map((id) => userById(sync, id));
    const ids = activeFriendId !== null ? [me.id, activeFriendId] : [me.id];
    return ids.map((id) => userById(sync, id));
  }, [sync, group, me.id, activeFriendId]);

  const friendOptions: User[] = useMemo(() => {
    const ids = new Set<number>(sync.friendIds);
    if (activeFriendId !== null) ids.add(activeFriendId);
    return [...ids].map((id) => userById(sync, id));
  }, [sync, activeFriendId]);

  // Changing the counterparty resets who-paid and the split to sane defaults.
  const changeFriend = (id: number) => {
    setActiveFriendId(id);
    setPayer(defaultPayerState(me.id));
    setSplit(defaultSplitState([me.id, id]));
  };

  const amountCents = parseAmountToCents(amountRaw, currency);
  const paidRes =
    amountCents !== null ? resolvePaid(payer, participants, amountCents, currency) : null;
  const splitRes =
    amountCents !== null ? resolveSplit(split, participants, amountCents, currency) : null;

  const descriptionError = description.trim() === '' ? 'Add a description.' : null;
  const amountError = amountCents === null ? 'Enter a valid amount.' : null;
  const dateError = date === '' ? 'Pick a date.' : null;
  const friendError =
    groupId === null && activeFriendId === null
      ? 'Add a friend first — expenses outside a group are shared with a friend.'
      : null;

  const buildInput = (): ExpenseInput | null => {
    if (
      descriptionError ||
      amountError ||
      dateError ||
      friendError ||
      amountCents === null ||
      !paidRes?.paid ||
      !splitRes?.owed
    ) {
      return null;
    }
    const paidMap = new Map(paidRes.paid.map((p) => [p.userId, p.paidCents]));
    const owedMap = new Map(splitRes.owed.map((o) => [o.userId, o.owedCents]));
    let shares: ExpenseShare[];
    if (groupId === null && activeFriendId !== null) {
      // Non-group: exactly [me, friend], even if one side is all zeros.
      shares = [me.id, activeFriendId].map((userId) => ({
        userId,
        paidCents: paidMap.get(userId) ?? 0,
        owedCents: owedMap.get(userId) ?? 0,
      }));
    } else {
      const ids = [...new Set([...paidMap.keys(), ...owedMap.keys()])].sort((a, b) => a - b);
      shares = ids
        .map((userId) => ({
          userId,
          paidCents: paidMap.get(userId) ?? 0,
          owedCents: owedMap.get(userId) ?? 0,
        }))
        .filter((s) => s.paidCents > 0 || s.owedCents > 0);
    }
    return {
      groupId,
      description: description.trim(),
      amountCents,
      currency,
      date,
      category,
      notes: showNotes && notes.trim() !== '' ? notes.trim() : null,
      isPayment: false,
      shares,
    };
  };

  const saving = createExpense.isPending || updateExpense.isPending;

  const handleSave = () => {
    setAttempted(true);
    const input = buildInput();
    if (!input) return;
    const callbacks = {
      onSuccess: () => {
        toast(isEdit ? 'Expense updated' : 'Expense added');
        onOpenChange(false);
      },
      onError: (err: Error) => toast.error(err.message),
    };
    if (expense) updateExpense.mutate({ id: expense.id, ...input }, callbacks);
    else createExpense.mutate(input, callbacks);
  };

  const handleDelete = () => {
    if (!expense) return;
    deleteExpense.mutate(expense.id, {
      onSuccess: () => {
        toast('Expense deleted');
        setConfirmOpen(false);
        onOpenChange(false);
      },
      onError: (err: Error) => toast.error(err.message),
    });
  };

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
          <Field data-invalid={attempted && descriptionError !== null}>
            <FieldLabel htmlFor="expense-description">Description</FieldLabel>
            <Input
              id="expense-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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
                    className="h-8 w-auto border-0 px-2.5 font-medium"
                    value={currency}
                    onValueChange={setCurrency}
                    options={currencyPickerOptions()}
                  />
                </InputGroupAddon>
              )}
              <InputGroupInput
                id="expense-amount"
                inputMode="decimal"
                placeholder={centsToInput(0, currency)}
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
              />
              {group ? (
                <InputGroupAddon align="inline-end" className="pr-3.5">
                  <InputGroupText>{currency}</InputGroupText>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            {attempted && amountError ? (
              <FieldDescription className="text-destructive">{amountError}</FieldDescription>
            ) : /[+\-*/()]/.test(amountRaw) && amountCents !== null ? (
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
                  value={activeFriendId !== null ? String(activeFriendId) : null}
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
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-11 rounded-full px-4"
            />
            {attempted && dateError ? (
              <FieldDescription className="text-destructive">{dateError}</FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Category</FieldLabel>
            <ToggleGroup
              value={[category]}
              onValueChange={(v) => {
                if (v[0]) setCategory(v[0] as Category);
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

          {showNotes ? (
            <Field>
              <FieldLabel htmlFor="expense-notes">Notes</FieldLabel>
              <Textarea
                id="expense-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
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
              onClick={() => setShowNotes(true)}
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
            value={payer}
            onChange={setPayer}
          />

          <SplitEditor
            participants={participants}
            meId={me.id}
            amountCents={amountCents}
            currency={currency}
            value={split}
            onChange={setSplit}
          />
        </FieldGroup>
      </div>

      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {!online ? (
          <FieldDescription className="text-center">
            You're offline — viewing only.
          </FieldDescription>
        ) : null}
        <Button
          className="h-12 w-full rounded-full"
          disabled={!online || saving}
          onClick={handleSave}
        >
          {saving ? <Spinner data-icon="inline-start" /> : null}
          {isEdit ? 'Save changes' : 'Save'}
        </Button>
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
