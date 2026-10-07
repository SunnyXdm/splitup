import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { ArrowLeftRight, ChevronDown, Plus } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import { UserAvatar } from '@/components/common/UserAvatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { errorMessage, isAmbiguousFailure, isStale } from '@/lib/api';
import { friendBalance } from '@/lib/balances';
import { createRetryMemo } from '@/lib/client-key';
import { formatDateSafe } from '@/lib/dates';
import {
  formatAmountInput,
  formatMoney,
  isCanonicalAmount,
  parseAmountToCents,
} from '@/lib/money';
import { properName } from '@/lib/names';
import {
  SYNC_KEY,
  useCreateExpense,
  useExpenseWritePending,
  useSettleUp,
  useSyncData,
  type CreateExpenseVars,
  type SettlementInput,
} from '@/lib/queries';
import {
  apportionSettle,
  balanceAfterPayment,
  currentSuggestion,
  nettingOf,
  pairBalance,
  pairConstituents,
  remainingBalance,
  settlementWatermark,
  settlePrefillFor,
  type RemainingBalance,
  type SettleRow,
} from '@/lib/settle';
import { SETTLEMENT_METHODS } from '@/lib/settlement-batches';
import type { SettlementMethod, SyncData, User } from '@/lib/types';
import { cn } from '@/lib/utils';
import { prefersReducedMotion, shakeInvalidFields } from '@/lib/motion';
import { DiscardChangesDialog, useCloseGuard, type CloseGuard } from './close-guard';
import { currencySymbol, relativeDay, todayISO } from './money-input';

export type SettleDirection = 'i_paid' | 'they_paid';

export interface SettleUpSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group to settle inside; null = settle a non-group (friend) balance. */
  groupId: number | null;
  /** Preselected counterparty. */
  toUserId?: number;
  /** Prefilled amount in minor units (else it comes from the person's balance). */
  suggestedCents?: number;
  currency: string;
  /**
   * Initial direction. Callers MUST pass this when prefilling from a balance:
   * defaulting to "I paid" when the other person owes you records the payment
   * backwards and doubles the debt.
   */
  direction?: SettleDirection;
}

type Direction = SettleDirection;

/** One settle submission, exactly as sent — kept for byte-identical retries. */
type SettleRequest =
  | { kind: 'settle'; body: SettlementInput }
  | { kind: 'payment'; body: CreateExpenseVars };

/** What the receipt state shows once a payment is recorded. */
interface Recorded {
  counterparty: User;
  direction: Direction;
  amountCents: number;
  currency: string;
  date: string;
  method: SettlementMethod | null;
  remaining: RemainingBalance;
}

export default function SettleUpSheet({
  open,
  onOpenChange,
  groupId,
  toUserId,
  suggestedCents,
  currency,
  direction,
}: SettleUpSheetProps) {
  const { guard, onSheetOpenChange, confirm } = useCloseGuard(onOpenChange);
  return (
    <>
      <Sheet open={open} onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-card"
        >
          {/* Mounted only while the sheet is open, so state resets between uses. */}
          <SettleBody
            onOpenChange={onOpenChange}
            groupId={groupId}
            toUserId={toUserId}
            suggestedCents={suggestedCents}
            currency={currency}
            direction={direction}
            guard={guard}
          />
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        {...confirm}
        description="The payment details you entered haven’t been recorded."
      />
    </>
  );
}

const nameOf = (u: User) => properName(u.name);

function SettleBody({
  onOpenChange,
  groupId,
  toUserId,
  suggestedCents,
  currency: initialCurrency,
  direction: initialDirection,
  guard,
}: Omit<SettleUpSheetProps, 'open'> & { guard: CloseGuard }) {
  const qc = useQueryClient();
  const { data: sync } = useSyncData();
  const online = useOnline();
  const createExpense = useCreateExpense();
  const settleUp = useSettleUp();
  const uid = useId();
  // Any optimistic expense write in flight means the cached balances (and the
  // watermark) don't match the server yet — recording now would 409 or route
  // against numbers that are about to change.
  const writePending = useExpenseWritePending();
  const retry = useRef(createRetryMemo<SettleRequest>()).current;
  const today = todayISO();

  // Friend mode can hold balances in several currencies; each is settled in
  // its own run of the sheet, so offer a switcher when more than one exists.
  const options: User[] = useMemo(() => {
    if (!sync) return [];
    const ids =
      groupId !== null
        ? (sync.groups.find((g) => g.id === groupId)?.memberIds ?? []).filter(
            (id) => id !== sync.me.id,
          )
        : sync.friendIds;
    const pool = new Set(ids);
    if (toUserId !== undefined) pool.add(toUserId);
    return [...pool].map(
      (id) =>
        sync.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null },
    );
  }, [sync, groupId, toUserId]);

  // The opening state. A caller's explicit prefill wins; otherwise it comes
  // from the (preselected or only possible) person's own balance. Guessing a
  // person among several invites recording against the wrong one, so then
  // the user must choose explicitly.
  const [initial] = useState(() => {
    const cp = toUserId ?? (options.length === 1 ? options[0].id : null);
    if (suggestedCents !== undefined || cp === null || !sync) {
      return {
        counterpartyId: cp,
        currency: initialCurrency,
        cents: suggestedCents ?? null,
        direction: initialDirection ?? ('i_paid' as Direction),
      };
    }
    const p = settlePrefillFor(sync, groupId, cp, initialCurrency);
    return { counterpartyId: cp, currency: p.currency, cents: p.cents, direction: p.direction };
  });
  const initialAmountRaw =
    initial.cents !== null ? formatAmountInput(initial.cents, initial.currency) : '';

  const [direction, setDirection] = useState<Direction>(initial.direction);
  const [counterpartyId, setCounterpartyId] = useState<number | null>(initial.counterpartyId);
  const [currency, setCurrency] = useState(initial.currency);
  const [amountRaw, setAmountRaw] = useState(initialAmountRaw);
  // The amount that would clear the balance exactly; refreshed when the
  // person changes or a stale 409 brings new balances.
  const [suggestion, setSuggestion] = useState<number | null>(initial.cents);
  const [date, setDate] = useState(today);
  const [attempted, setAttempted] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  // Optional receipt details, tucked behind "Add details".
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [method, setMethod] = useState<SettlementMethod | null>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [recorded, setRecorded] = useState<Recorded | null>(null);

  // Unsaved details ask before the sheet closes; a recorded payment never does.
  const unsaved =
    recorded === null &&
    (method !== null ||
      reference.trim() !== '' ||
      note.trim() !== '' ||
      date !== today ||
      amountRaw !== initialAmountRaw);
  const unsavedRef = useRef(unsaved);
  useLayoutEffect(() => {
    unsavedRef.current = unsaved;
  });
  useLayoutEffect(() => {
    guard(() => unsavedRef.current);
    return () => guard(null);
  }, [guard]);

  const balanceEntries = useMemo(
    () =>
      groupId === null && sync && counterpartyId !== null
        ? friendBalance(sync, counterpartyId).filter((b) => b.netCents !== 0)
        : [],
    [groupId, sync, counterpartyId],
  );
  const currencyOptions = useMemo(() => {
    const set = new Set<string>(balanceEntries.map((b) => b.currency));
    set.add(currency);
    return [...set].sort();
  }, [balanceEntries, currency]);

  /** Prefill from THIS suggestion — nothing carries over from before. */
  const applyPrefill = (cents: number | null, dir: Direction, cur: string) => {
    setCurrency(cur);
    setAmountRaw(cents !== null ? formatAmountInput(cents, cur) : '');
    setDirection(dir);
    setSuggestion(cents);
  };

  const changeCounterparty = (id: number) => {
    setCounterpartyId(id);
    if (!sync) return;
    const p = settlePrefillFor(sync, groupId, id, currency);
    applyPrefill(p.cents, p.direction, p.currency);
  };

  const switchCurrency = (next: string) => {
    if (!sync || counterpartyId === null) return;
    const s = currentSuggestion(sync, groupId, counterpartyId, next);
    applyPrefill(s?.cents ?? null, s?.direction ?? direction, next);
  };

  const amountCents = parseAmountToCents(amountRaw, currency);
  const counterparty = options.find((u) => u.id === counterpartyId) ?? null;

  // Friend mode: a friend balance is a sum of per-group routed edges plus the
  // direct residue, so the payment is decomposed into one row per slice —
  // that's what keeps group pages, friend pages, and totals agreeing.
  const constituents = useMemo(
    () =>
      groupId === null && sync && counterpartyId !== null
        ? pairConstituents(sync, counterpartyId, currency)
        : [],
    [groupId, sync, counterpartyId, currency],
  );
  const settleRows: SettleRow[] = useMemo(() => {
    if (groupId !== null || !sync || counterpartyId === null) return [];
    if (amountCents === null || amountCents <= 0) return [];
    return apportionSettle(constituents, amountCents, direction, sync.me.id, counterpartyId);
  }, [groupId, sync, counterpartyId, constituents, amountCents, direction]);

  if (!sync) {
    return (
      <>
        <SheetHeader className="pr-14">
          <SheetTitle className="text-xl">Record a payment</SheetTitle>
        </SheetHeader>
        <FieldDescription className="px-4 pb-6">
          Your data hasn't loaded yet — try again in a moment.
        </FieldDescription>
      </>
    );
  }

  if (recorded) {
    return <Receipt recorded={recorded} onDone={() => onOpenChange(false)} />;
  }

  const me = sync.me;
  const settleGroup = groupId !== null ? sync.groups.find((g) => g.id === groupId) : undefined;
  // Everything except a legacy off-currency group edge goes through the
  // settlements endpoint, which is what stores receipt details.
  const usesSettlements =
    groupId === null || (settleGroup !== undefined && currency === settleGroup.currency);
  const details = {
    ...(method !== null ? { method } : {}),
    ...(reference.trim() ? { reference: reference.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  const amountError = amountCents === null ? 'Enter a valid amount.' : null;
  const counterpartyError = counterparty === null ? 'Choose who you settled with.' : null;
  const dateError =
    date === '' ? 'Pick the payment date.' : date > today ? 'That date is in the future.' : null;

  // Rows as they'd be recorded (friend mode: apportioned; group: one row).
  const rows =
    counterparty === null || amountCents === null
      ? []
      : groupId === null
        ? settleRows
        : [
            {
              groupId,
              payerId: direction === 'i_paid' ? me.id : counterparty.id,
              recipientId: direction === 'i_paid' ? counterparty.id : me.id,
              amountCents,
            },
          ];
  const before = counterparty ? pairBalance(sync, groupId, counterparty.id, currency) : 0;
  const remaining =
    counterparty && rows.length > 0
      ? remainingBalance(
          before,
          balanceAfterPayment(sync, groupId, counterparty.id, currency, rows),
        )
      : null;
  const netting = nettingOf(constituents);
  const showBreakdown =
    counterparty !== null &&
    settleRows.length > 0 &&
    !(settleRows.length === 1 && settleRows[0].groupId === null);

  // 409 'stale': balances moved under us (someone recorded or edited
  // something). Pull the fresh dataset and re-suggest from the NEW balance, so
  // the user reviews real numbers instead of re-submitting the old amount.
  const refreshAfterStale = async (counterId: number) => {
    toast.error('Balances changed — the amount has been updated, review it and try again.');
    await qc.refetchQueries({ queryKey: SYNC_KEY });
    const fresh = qc.getQueryData<SyncData>(SYNC_KEY);
    if (!fresh) return;
    const next = currentSuggestion(fresh, groupId, counterId, currency);
    applyPrefill(next?.cents ?? null, next?.direction ?? direction, currency);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAttempted(true);
    if (amountCents === null || counterparty === null || dateError !== null) {
      shakeInvalidFields(e.currentTarget);
      const first =
        counterparty === null
          ? `${uid}-with`
          : amountCents === null
            ? `${uid}-amount`
            : `${uid}-date`;
      const el = document.getElementById(first);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    if (writePending) return;
    if (groupId === null && settleRows.length === 0) return;
    const remainingNow = remaining ?? remainingBalance(before, before);

    const callbacks = {
      onSuccess: () => {
        retry.reset();
        // The delight moment, only when it really squared things up.
        if (remainingNow.settled && !prefersReducedMotion()) {
          void confetti({
            particleCount: 90,
            spread: 70,
            startVelocity: 38,
            origin: { y: 0.8 },
            colors: ['#f37338', '#2e6e4c', '#141413', '#f3f0ee'],
            disableForReducedMotion: true,
          });
        }
        setRecorded({
          counterparty,
          direction,
          amountCents,
          currency,
          date,
          method,
          remaining: remainingNow,
        });
      },
      onError: (err: Error) => {
        // A definite rejection means nothing was recorded: the next tap builds
        // a fresh request. After an ambiguous failure the kept request (same
        // key, same body) is what a retry resends, so it can't record twice.
        if (!isAmbiguousFailure(err)) retry.reset();
        if (isStale(err)) void refreshAfterStale(counterparty.id);
        else toast.error(errorMessage(err));
      },
    };

    // Only what the user can see and change decides whether this is a retry;
    // the watermark and row breakdown are derived and move with every refetch.
    const inputs = {
      groupId,
      counterpartyId: counterparty.id,
      direction,
      currency,
      amountCents,
      date,
      ...details,
    };
    const request = retry.request(inputs, (clientKey): SettleRequest => {
      if (groupId === null) {
        // Friend mode: record the apportioned rows atomically.
        return {
          kind: 'settle',
          body: {
            counterpartyId: counterparty.id,
            currency,
            date,
            ...settlementWatermark(sync, counterparty.id),
            rows: settleRows.map(({ groupId: g, payerId, recipientId, amountCents: cents }) => ({
              groupId: g,
              payerId,
              recipientId,
              amountCents: cents,
            })),
            ...details,
            clientKey,
          },
        };
      }
      const payerId = direction === 'i_paid' ? me.id : counterparty.id;
      const recipientId = direction === 'i_paid' ? counterparty.id : me.id;
      if (usesSettlements) {
        // In-group settle goes through the settlements endpoint too: the
        // watermark makes a concurrent, stale settle fail with 409 instead of
        // landing on top of the other one and reversing the debt.
        return {
          kind: 'settle',
          body: {
            counterpartyId: counterparty.id,
            currency,
            date,
            ...settlementWatermark(sync, counterparty.id),
            rows: [{ groupId, payerId, recipientId, amountCents }],
            ...details,
            clientKey,
          },
        };
      }
      // Legacy edge in a non-group currency: the settlements endpoint only
      // accepts group-currency rows, so record a plain payment.
      return {
        kind: 'payment',
        body: {
          groupId,
          description: 'Payment',
          amountCents,
          currency,
          date,
          category: 'general',
          notes: null,
          isPayment: true,
          shares: [
            { userId: payerId, paidCents: amountCents, owedCents: 0 },
            { userId: recipientId, paidCents: 0, owedCents: amountCents },
          ],
          clientKey,
        },
      };
    });
    if (request.kind === 'settle') settleUp.mutate(request.body, callbacks);
    else createExpense.mutate(request.body, callbacks);
  };

  const who = counterparty ? nameOf(counterparty) : null;
  const sentence =
    who === null ? null : direction === 'they_paid' ? `${who} paid you` : `You paid ${who}`;
  const scopeLine =
    groupId === null
      ? 'Across your groups and direct expenses'
      : `Only ${settleGroup?.name ?? 'this group'}`;
  const balanceLine =
    who === null
      ? null
      : before > 0
        ? `${who} owes you ${formatMoney(before, currency)}`
        : before < 0
          ? `You owe ${who} ${formatMoney(-before, currency)}`
          : `You and ${who} are settled up${currencyOptions.length > 1 ? ` in ${currency}` : ''}`;
  const saving = createExpense.isPending || settleUp.isPending;
  const dayLabel = date ? relativeDay(date, today) : null;

  return (
    <form noValidate onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="pr-14">
        <SheetTitle className="text-xl">Record a payment</SheetTitle>
        <SheetDescription>
          For money that already changed hands — Splitup doesn’t move money.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup className="gap-6 pb-4">
          {/* Who, which way, and over what */}
          <Field data-invalid={attempted && counterpartyError !== null}>
            <FieldLabel htmlFor={`${uid}-with`}>With</FieldLabel>
            <PickerSelect
              id={`${uid}-with`}
              title="Who was the payment with?"
              placeholder="Choose a person"
              value={counterpartyId !== null ? String(counterpartyId) : null}
              onValueChange={(v) => changeCounterparty(Number(v))}
              options={options.map((u) => {
                const s =
                  groupId !== null ? currentSuggestion(sync, groupId, u.id, currency) : null;
                return {
                  value: String(u.id),
                  label: nameOf(u),
                  sublabel: s
                    ? s.direction === 'they_paid'
                      ? `owes you ${formatMoney(s.cents, currency)}`
                      : `you owe ${formatMoney(s.cents, currency)}`
                    : undefined,
                  leading: <UserAvatar user={u} size="sm" />,
                };
              })}
            />
            {attempted && counterpartyError ? (
              <FieldDescription className="text-destructive">{counterpartyError}</FieldDescription>
            ) : null}
          </Field>

          {counterparty !== null ? (
            <div className="flex flex-col gap-3 rounded-panel bg-muted/60 p-4">
              <div className="flex items-center gap-3">
                <UserAvatar user={counterparty} className="size-11" />
                <p
                  className="min-w-0 flex-1 text-lg leading-tight font-medium tracking-tight break-words"
                  aria-live="polite"
                >
                  {sentence}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="pill"
                  className="shrink-0 px-4"
                  aria-label={`Swap direction — ${direction === 'they_paid' ? `you paid ${who}` : `${who} paid you`}`}
                  onClick={() => setDirection((d) => (d === 'i_paid' ? 'they_paid' : 'i_paid'))}
                >
                  <ArrowLeftRight data-icon="inline-start" aria-hidden="true" />
                  Swap
                </Button>
              </div>
              <div className="flex flex-col gap-0.5 text-sm">
                <p className="text-muted-foreground">{scopeLine}</p>
                {balanceLine ? <p>Right now: {balanceLine}</p> : null}
              </div>
              {netting ? <NettingLine netting={netting} currency={currency} /> : null}
            </div>
          ) : null}

          {groupId === null && currencyOptions.length > 1 ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-currency`}>Currency</FieldLabel>
              <PickerSelect
                id={`${uid}-currency`}
                title="Currency"
                value={currency}
                onValueChange={switchCurrency}
                options={currencyOptions.map((code) => {
                  const entry = balanceEntries.find((b) => b.currency === code);
                  return {
                    value: code,
                    label: code,
                    sublabel: entry
                      ? `${entry.netCents > 0 ? 'owes you' : 'you owe'} ${formatMoney(Math.abs(entry.netCents), code)}`
                      : undefined,
                  };
                })}
              />
              <FieldDescription>
                Balances in different currencies settle separately.
              </FieldDescription>
            </Field>
          ) : null}

          <Field data-invalid={attempted && amountError !== null}>
            <FieldLabel htmlFor={`${uid}-amount`}>Amount</FieldLabel>
            <InputGroup className="h-14 rounded-full">
              <InputGroupAddon className="pl-5">
                <InputGroupText className="text-xl text-foreground">
                  {currencySymbol(currency)}
                </InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={`${uid}-amount`}
                inputMode="decimal"
                autoComplete="off"
                placeholder={formatAmountInput(0, currency)}
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                onBlur={() => {
                  // Group the digits once typed ("281152.66" → "2,81,152.66"),
                  // but leave arithmetic as written.
                  if (amountCents !== null && !/[+\-*/()]/.test(amountRaw)) {
                    setAmountRaw(formatAmountInput(amountCents, currency));
                  }
                }}
                aria-invalid={(attempted && amountError !== null) || undefined}
                aria-describedby={attempted && amountError ? `${uid}-amount-error` : `${uid}-after`}
                className="text-2xl font-medium tabular-nums md:text-2xl"
              />
              <InputGroupAddon align="inline-end" className="pr-5">
                <InputGroupText>{currency}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            {attempted && amountError ? (
              <FieldDescription id={`${uid}-amount-error`} className="text-destructive">
                {amountError}
              </FieldDescription>
            ) : amountCents !== null &&
              /[+\-*/()]/.test(amountRaw) &&
              !isCanonicalAmount(amountRaw) ? (
              <FieldDescription>= {formatMoney(amountCents, currency)}</FieldDescription>
            ) : null}
            {suggestion !== null && amountCents !== suggestion && counterparty ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 w-auto! self-start rounded-full"
                onClick={() => setAmountRaw(formatAmountInput(suggestion, currency))}
              >
                Use the full balance · {formatMoney(suggestion, currency)}
              </Button>
            ) : null}
          </Field>

          {remaining && counterparty && who ? (
            <AfterLine
              id={`${uid}-after`}
              remaining={remaining}
              who={who}
              currency={currency}
              groupName={groupId !== null ? (settleGroup?.name ?? null) : null}
              beforeCents={before}
            />
          ) : null}

          <Field data-invalid={attempted && dateError !== null}>
            <FieldLabel htmlFor={`${uid}-date`}>Payment date</FieldLabel>
            <InputGroup className="h-11 rounded-full">
              <InputGroupInput
                id={`${uid}-date`}
                type="date"
                max={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={(attempted && dateError !== null) || undefined}
                aria-describedby={attempted && dateError ? `${uid}-date-error` : undefined}
                className="pl-4"
              />
              {dayLabel ? (
                <InputGroupAddon align="inline-end" className="pr-4">
                  <InputGroupText>{dayLabel}</InputGroupText>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            {attempted && dateError ? (
              <FieldDescription id={`${uid}-date-error`} className="text-destructive">
                {dateError}
              </FieldDescription>
            ) : null}
          </Field>

          {/* Friend mode: where each slice of this payment is recorded. */}
          {showBreakdown && counterparty ? (
            <Field>
              <button
                type="button"
                aria-expanded={breakdownOpen}
                aria-controls={`${uid}-breakdown`}
                onClick={() => setBreakdownOpen((o) => !o)}
                className="pressable flex min-h-12 w-full items-center gap-3 rounded-panel px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-focus-ring"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">How it’s recorded</span>
                  <span className="text-sm text-muted-foreground">
                    {breakdownSummary(settleRows)}
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'size-5 shrink-0 text-muted-foreground transition-transform duration-(--dur-base)',
                    breakdownOpen && 'rotate-180',
                  )}
                />
              </button>
              {breakdownOpen ? (
                <Breakdown
                  id={`${uid}-breakdown`}
                  rows={settleRows}
                  sync={sync}
                  counterparty={counterparty}
                  currency={currency}
                  amountCents={amountCents ?? 0}
                />
              ) : null}
            </Field>
          ) : null}

          {usesSettlements && !detailsOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 w-auto! self-start rounded-full"
              onClick={() => setDetailsOpen(true)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add details (method, reference, note)
            </Button>
          ) : null}
          {usesSettlements && detailsOpen ? (
            <>
              <Field>
                <FieldLabel id={`${uid}-method`}>Method</FieldLabel>
                <ToggleGroup
                  value={method ? [method] : []}
                  onValueChange={(v) => setMethod((v[0] as SettlementMethod | undefined) ?? null)}
                  className="flex w-full flex-wrap gap-2"
                  aria-labelledby={`${uid}-method`}
                >
                  {SETTLEMENT_METHODS.map((m) => (
                    <ToggleGroupItem
                      key={m.value}
                      value={m.value}
                      variant="outline"
                      className="h-11 rounded-full px-4 aria-pressed:border-primary aria-pressed:bg-muted"
                    >
                      {m.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-reference`}>Reference</FieldLabel>
                <Input
                  id={`${uid}-reference`}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="e.g. UPI transaction ID"
                  className="h-11 rounded-full px-4"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-note`}>Note</FieldLabel>
                <Textarea
                  id={`${uid}-note`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="Anything worth remembering"
                  className="rounded-panel px-4"
                />
              </Field>
            </>
          ) : null}
        </FieldGroup>
      </div>
      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {!online ? (
          <FieldDescription className="text-center">
            You're offline — viewing only.
          </FieldDescription>
        ) : writePending && !saving ? (
          <FieldDescription className="text-center">
            Waiting for your other changes to save…
          </FieldDescription>
        ) : null}
        <Button type="submit" size="cta" className="w-full" disabled={!online || writePending}>
          {saving ? <Spinner data-icon="inline-start" /> : null}
          Record payment
        </Button>
      </SheetFooter>
    </form>
  );
}

/** "₹50,985.46 owed to you − ₹3,070.00 you owe = ₹47,915.46" */
function NettingLine({
  netting,
  currency,
}: {
  netting: { owedToYouCents: number; youOweCents: number; netCents: number };
  currency: string;
}) {
  const fmt = (c: number) => formatMoney(c, currency);
  const theyOwe = netting.netCents >= 0;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
      <p className="text-muted-foreground">
        Balances run both ways across your groups, so they net out:
      </p>
      <p className="font-medium tabular-nums">
        {theyOwe ? (
          <>
            {fmt(netting.owedToYouCents)} owed to you − {fmt(netting.youOweCents)} you owe ={' '}
            {fmt(netting.netCents)}
          </>
        ) : (
          <>
            {fmt(netting.youOweCents)} you owe − {fmt(netting.owedToYouCents)} owed to you ={' '}
            {fmt(-netting.netCents)} you owe
          </>
        )}
      </p>
    </div>
  );
}

/** "Remaining balance after recording" — including when it flips the other way. */
function AfterLine({
  id,
  remaining,
  who,
  currency,
  groupName,
  beforeCents,
}: {
  id: string;
  remaining: RemainingBalance;
  who: string;
  currency: string;
  groupName: string | null;
  beforeCents: number;
}) {
  const fmt = (c: number) => formatMoney(Math.abs(c), currency);
  const where = groupName ? ` in ${groupName}` : '';
  // Recorded against the balance's direction: the debt grows instead of shrinking.
  const grows =
    !remaining.reversed &&
    beforeCents !== 0 &&
    Math.abs(remaining.afterCents) > Math.abs(beforeCents);
  const still = !remaining.reversed && !grows && beforeCents !== 0 ? 'still ' : '';
  const text = remaining.settled
    ? `You and ${who} will be all settled up${where}.`
    : remaining.afterCents > 0
      ? `${who} will ${still}owe you ${fmt(remaining.afterCents)}${where}.`
      : `You’ll ${still}owe ${who} ${fmt(remaining.afterCents)}${where}.`;
  return (
    <div
      id={id}
      role="status"
      className={cn(
        'flex flex-col gap-1 rounded-panel px-4 py-3 text-sm',
        remaining.reversed || grows ? 'bg-warning/10' : 'bg-muted/60',
      )}
    >
      <p className="text-muted-foreground">Remaining balance after recording</p>
      <p className="font-medium">{text}</p>
      {remaining.reversed ? (
        <p className="text-muted-foreground">
          This is {fmt(remaining.overpaidCents)} more than the balance, so the extra turns into a
          debt the other way.
        </p>
      ) : grows ? (
        <p className="text-muted-foreground">
          This payment runs the other way from the balance, so it adds to it — check the
          direction.
        </p>
      ) : null}
    </div>
  );
}

function breakdownSummary(rows: SettleRow[]): string {
  const groups = new Set(rows.filter((r) => r.groupId !== null).map((r) => r.groupId)).size;
  const direct = rows.some((r) => r.groupId === null);
  const parts = [
    groups > 0 ? `${groups} ${groups === 1 ? 'group' : 'groups'}` : null,
    direct ? 'direct expenses' : null,
  ].filter(Boolean);
  return `Spread across ${parts.join(' + ')}`;
}

/**
 * The per-group rows, collapsed by default: group name on its own line, the
 * direction under it, and signed amounts — offsets (rows running the other
 * way) are minus, so the column visibly adds up to what changed hands.
 */
function Breakdown({
  id,
  rows,
  sync,
  counterparty,
  currency,
  amountCents,
}: {
  id: string;
  rows: SettleRow[];
  sync: SyncData;
  counterparty: User;
  currency: string;
  amountCents: number;
}) {
  const me = sync.me.id;
  const who = nameOf(counterparty);
  return (
    <div id={id} className="flex flex-col rounded-panel border border-border px-4 py-2">
      <ul className="flex flex-col divide-y divide-border/60">
        {rows.map((r, i) => {
          const group = r.groupId !== null ? sync.groups.find((g) => g.id === r.groupId) : null;
          return (
            <li key={i} className="flex items-start justify-between gap-3 py-2.5 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium break-words">
                  {group ? `${group.emoji} ${group.name}` : 'Direct expenses'}
                </span>
                <span className="text-muted-foreground">
                  {r.payerId === me ? `You → ${who}` : `${who} → you`}
                  {r.counter ? ' · offsets what runs the other way' : ''}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 font-medium whitespace-nowrap tabular-nums',
                  r.counter && 'text-muted-foreground',
                )}
              >
                {r.counter ? '−' : '+'}
                {formatMoney(r.amountCents, currency)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="flex justify-between gap-3 border-t border-border py-2.5 text-sm font-medium">
        <span>Changes hands</span>
        <span className="tabular-nums">{formatMoney(amountCents, currency)}</span>
      </p>
    </div>
  );
}

/** The stable result: who, how much, and where that leaves you. "Done" closes. */
function Receipt({ recorded, onDone }: { recorded: Recorded; onDone: () => void }) {
  const who = nameOf(recorded.counterparty);
  const fmt = (c: number) => formatMoney(Math.abs(c), recorded.currency);
  const { remaining } = recorded;
  const after = remaining.settled
    ? `You and ${who} are all settled up.`
    : remaining.afterCents > 0
      ? `${who} now owes you ${fmt(remaining.afterCents)}.`
      : `You now owe ${who} ${fmt(remaining.afterCents)}.`;
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => doneRef.current?.focus(), []);
  return (
    <>
      <SheetHeader className="pr-14">
        <SheetTitle className="text-xl">Payment recorded</SheetTitle>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" role="status">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <svg
            viewBox="0 0 64 64"
            className="size-16 animate-[check-pop_var(--dur-slow)_cubic-bezier(0.34,1.56,0.64,1)_both] text-owed"
            aria-hidden="true"
          >
            <circle cx="32" cy="32" r="30" className="fill-current opacity-15" />
            <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeWidth="2.5" />
            <path
              d="M20 33.5 28.5 42 45 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1}
              className="animate-[check-draw_var(--dur-slow)_var(--ease-out-expo)_160ms_forwards]"
            />
          </svg>
          <p className="text-2xl font-medium tracking-tight tabular-nums">
            {fmt(recorded.amountCents)}
          </p>
          <p className="text-base">
            {recorded.direction === 'they_paid' ? `${who} paid you` : `You paid ${who}`}
          </p>
        </div>
        <dl className="flex flex-col divide-y divide-border/60 rounded-panel bg-muted/60 px-4 text-sm">
          <div className="flex justify-between gap-3 py-3">
            <dt className="text-muted-foreground">Date</dt>
            <dd>{formatDateSafe(recorded.date, 'EEE, d MMM yyyy')}</dd>
          </div>
          {recorded.method ? (
            <div className="flex justify-between gap-3 py-3">
              <dt className="text-muted-foreground">Method</dt>
              <dd>
                {SETTLEMENT_METHODS.find((m) => m.value === recorded.method)?.label ??
                  recorded.method}
              </dd>
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5 py-3">
            <dt className="text-muted-foreground">Remaining balance</dt>
            <dd className="font-medium">{after}</dd>
          </div>
        </dl>
      </div>
      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <Button ref={doneRef} type="button" size="cta" className="w-full" onClick={onDone}>
          Done
        </Button>
      </SheetFooter>
    </>
  );
}
