import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
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
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { errorMessage, isAmbiguousFailure, isStale } from '@/lib/api';
import { friendBalance } from '@/lib/balances';
import { createRetryMemo } from '@/lib/client-key';
import { formatMoney, isCanonicalAmount, parseAmountToCents } from '@/lib/money';
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
  currentSuggestion,
  pairConstituents,
  settlementWatermark,
} from '@/lib/settle';
import { SETTLEMENT_METHODS } from '@/lib/settlement-batches';
import type { SettlementMethod, SyncData, User } from '@/lib/types';
import { centsToInput, currencySymbol, todayISO } from './money-input';

export type SettleDirection = 'i_paid' | 'they_paid';

export interface SettleUpSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Group to settle inside; null = settle a non-group (friend) balance. */
  groupId: number | null;
  /** Preselected counterparty. */
  toUserId?: number;
  /** Prefilled amount in minor units. */
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

export default function SettleUpSheet({
  open,
  onOpenChange,
  groupId,
  toUserId,
  suggestedCents,
  currency,
  direction,
}: SettleUpSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl rounded-t-[28px]"
      >
        {/* Mounted only while the sheet is open, so state resets between uses. */}
        <SettleBody
          onOpenChange={onOpenChange}
          groupId={groupId}
          toUserId={toUserId}
          suggestedCents={suggestedCents}
          currency={currency}
          direction={direction}
        />
      </SheetContent>
    </Sheet>
  );
}

function SettleBody({
  onOpenChange,
  groupId,
  toUserId,
  suggestedCents,
  currency: initialCurrency,
  direction: initialDirection,
}: Omit<SettleUpSheetProps, 'open'>) {
  const qc = useQueryClient();
  const { data: sync } = useSyncData();
  const online = useOnline();
  const createExpense = useCreateExpense();
  const settleUp = useSettleUp();
  // Any optimistic expense write in flight means the cached balances (and the
  // watermark) don't match the server yet — recording now would 409 or route
  // against numbers that are about to change.
  const writePending = useExpenseWritePending();
  const retry = useRef(createRetryMemo<SettleRequest>()).current;

  const [direction, setDirection] = useState<Direction>(initialDirection ?? 'i_paid');
  const [chosenCounterpartyId, setCounterpartyId] = useState<number | null>(toUserId ?? null);
  const [currency, setCurrency] = useState(initialCurrency);
  const [amountRaw, setAmountRaw] = useState(
    suggestedCents !== undefined ? centsToInput(suggestedCents, initialCurrency) : '',
  );
  // The amount that would clear the balance exactly (for the confetti moment);
  // refreshed when a stale 409 brings new balances.
  const [suggestion, setSuggestion] = useState<number | undefined>(suggestedCents);
  const [attempted, setAttempted] = useState(false);
  // Optional receipt details, tucked behind "Add details".
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [method, setMethod] = useState<SettlementMethod | null>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

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
    if (chosenCounterpartyId !== null) pool.add(chosenCounterpartyId);
    return [...pool].map(
      (id) =>
        sync.users.find((u) => u.id === id) ?? {
          id,
          name: 'Someone',
          email: null,
          picture: null,
        },
    );
  }, [sync, groupId, chosenCounterpartyId]);

  // Auto-select only an unambiguous counterparty; guessing (e.g. the first
  // member by join order) invites recording a payment against the wrong
  // person — the user must choose explicitly.
  const counterpartyId = chosenCounterpartyId ?? (options.length === 1 ? options[0].id : null);

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

  const switchCurrency = (next: string) => {
    setCurrency(next);
    const entry = balanceEntries.find((b) => b.currency === next);
    if (entry) {
      setAmountRaw(centsToInput(Math.abs(entry.netCents), next));
      setDirection(entry.netCents > 0 ? 'they_paid' : 'i_paid');
      setSuggestion(Math.abs(entry.netCents));
    } else {
      setAmountRaw('');
      setSuggestion(undefined);
    }
  };

  const amountCents = parseAmountToCents(amountRaw, currency);

  // Friend mode: a friend balance is a sum of per-group routed edges plus the
  // direct residue, so the payment is decomposed into one row per slice —
  // that's what keeps group pages, friend pages, and totals agreeing.
  const settleRows = useMemo(() => {
    if (groupId !== null || !sync || counterpartyId === null) return [];
    if (amountCents === null || amountCents <= 0) return [];
    const constituents = pairConstituents(sync, counterpartyId, currency);
    return apportionSettle(constituents, amountCents, direction, sync.me.id, counterpartyId);
  }, [groupId, sync, counterpartyId, currency, amountCents, direction]);

  if (!sync) {
    return (
      <>
        <SheetHeader className="pb-0">
          <SheetTitle className="text-xl">Settle up</SheetTitle>
        </SheetHeader>
        <FieldDescription className="px-4 pb-6">
          Your data hasn't loaded yet — try again in a moment.
        </FieldDescription>
      </>
    );
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
  const counterparty = options.find((u) => u.id === counterpartyId) ?? null;
  const amountError = amountCents === null ? 'Enter a valid amount.' : null;
  const counterpartyError = counterparty === null ? 'Choose who you settled with.' : null;

  const celebrate = () => {
    toast('Payment recorded');
    // The delight moment: this payment cleared the suggested balance exactly.
    if (
      suggestion !== undefined &&
      amountCents === suggestion &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      void confetti({
        particleCount: 90,
        spread: 70,
        startVelocity: 38,
        origin: { y: 0.8 },
        colors: ['#f37338', '#2e6e4c', '#141413', '#f3f0ee'],
        disableForReducedMotion: true,
      });
    }
    onOpenChange(false);
  };

  // 409 'stale': balances moved under us (someone recorded or edited
  // something). Pull the fresh dataset and re-suggest from the NEW balance, so
  // the user reviews real numbers instead of re-submitting the old amount.
  const refreshAfterStale = async (counterId: number) => {
    toast.error('Balances changed — the amount has been updated, review it and try again.');
    await qc.refetchQueries({ queryKey: SYNC_KEY });
    const fresh = qc.getQueryData<SyncData>(SYNC_KEY);
    if (!fresh) return;
    const next = currentSuggestion(fresh, groupId, counterId, currency);
    setSuggestion(next?.cents);
    setAmountRaw(next ? centsToInput(next.cents, currency) : '');
    if (next) setDirection(next.direction);
  };

  const handleSave = () => {
    setAttempted(true);
    if (amountCents === null || counterparty === null || writePending) return;
    if (groupId === null && settleRows.length === 0) return;

    const callbacks = {
      onSuccess: () => {
        retry.reset();
        celebrate();
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
            date: todayISO(),
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
            date: todayISO(),
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
          date: todayISO(),
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

  return (
    <>
      <SheetHeader className="pb-0">
        <SheetTitle className="text-xl">Settle up</SheetTitle>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <FieldGroup className="pb-2">
          <Field>
            <ToggleGroup
              value={[direction]}
              onValueChange={(v) => {
                if (v[0]) setDirection(v[0] as Direction);
              }}
              className="w-full"
              aria-label="Who paid"
            >
              <ToggleGroupItem
                value="i_paid"
                variant="outline"
                className="h-11 min-w-0 flex-1 rounded-full aria-pressed:border-primary"
              >
                I paid
              </ToggleGroupItem>
              <ToggleGroupItem
                value="they_paid"
                variant="outline"
                className="h-11 min-w-0 flex-1 rounded-full aria-pressed:border-primary"
              >
                They paid me
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field data-invalid={attempted && counterpartyError !== null}>
            <FieldLabel htmlFor="settle-with">{direction === 'i_paid' ? 'To' : 'From'}</FieldLabel>
            <PickerSelect
              id="settle-with"
              title="Settle with"
              placeholder="Choose a person"
              value={counterpartyId !== null ? String(counterpartyId) : null}
              onValueChange={(v) => setCounterpartyId(Number(v))}
              options={options.map((u) => ({
                value: String(u.id),
                label: u.name,
                leading: <UserAvatar user={u} size="sm" />,
              }))}
            />
            {attempted && counterpartyError ? (
              <FieldDescription className="text-destructive">{counterpartyError}</FieldDescription>
            ) : null}
          </Field>

          {groupId === null && currencyOptions.length > 1 ? (
            <Field>
              <FieldLabel htmlFor="settle-currency">Currency</FieldLabel>
              <PickerSelect
                id="settle-currency"
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
            <FieldLabel htmlFor="settle-amount">Amount</FieldLabel>
            <InputGroup className="h-11 rounded-full">
              <InputGroupAddon className="pl-3.5">
                <InputGroupText>{currencySymbol(currency)}</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="settle-amount"
                inputMode="decimal"
                placeholder={centsToInput(0, currency)}
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
              />
              <InputGroupAddon align="inline-end" className="pr-3.5">
                <InputGroupText>{currency}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            {attempted && amountError ? (
              <FieldDescription className="text-destructive">{amountError}</FieldDescription>
            ) : amountCents !== null && !isCanonicalAmount(amountRaw) && counterparty === null ? (
              <FieldDescription>= {formatMoney(amountCents, currency)}</FieldDescription>
            ) : amountCents !== null && counterparty !== null ? (
              <FieldDescription>
                {direction === 'i_paid'
                  ? `You paid ${counterparty.name} ${formatMoney(amountCents, currency)}.`
                  : `${counterparty.name} paid you ${formatMoney(amountCents, currency)}.`}
              </FieldDescription>
            ) : null}
          </Field>

          {/* Friend mode: show where each slice of this payment will be
              recorded, so group balances visibly settle along with it. */}
          {counterparty !== null &&
          settleRows.length > 0 &&
          !(settleRows.length === 1 && settleRows[0].groupId === null) ? (
            <Field>
              <FieldLabel>Recorded as</FieldLabel>
              <div className="flex flex-col gap-1 rounded-[20px] bg-muted/50 px-4 py-3">
                {settleRows.map((r, i) => {
                  const group =
                    r.groupId !== null ? sync.groups.find((g) => g.id === r.groupId) : null;
                  const scopeLabel = group ? `${group.emoji} ${group.name}` : 'Direct';
                  const dirLabel =
                    r.payerId === me.id
                      ? `You → ${counterparty.name}`
                      : `${counterparty.name} → You`;
                  return (
                    <div
                      key={i}
                      className={`flex items-baseline justify-between gap-3 text-sm ${
                        r.counter ? 'text-muted-foreground' : ''
                      }`}
                    >
                      <span className="min-w-0 truncate">
                        {scopeLabel}
                        <span className="text-muted-foreground"> · {dirLabel}</span>
                        {r.counter ? (
                          <span className="text-muted-foreground"> (offsets)</span>
                        ) : null}
                      </span>
                      <span className="whitespace-nowrap tabular-nums">
                        {formatMoney(r.amountCents, currency)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {settleRows.some((r) => r.counter) ? (
                <FieldDescription>
                  Some balances run in opposite directions across your groups — the offsetting
                  entries make each group settle while only the net amount changes hands.
                </FieldDescription>
              ) : null}
            </Field>
          ) : null}

          {usesSettlements && !detailsOpen ? (
            <Button
              variant="ghost"
              className="h-10 self-start rounded-full px-3 text-muted-foreground"
              onClick={() => setDetailsOpen(true)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add details
            </Button>
          ) : null}
          {usesSettlements && detailsOpen ? (
            <>
              <Field>
                <FieldLabel id="settle-method-label">Method</FieldLabel>
                <ToggleGroup
                  value={method ? [method] : []}
                  onValueChange={(v) => setMethod((v[0] as SettlementMethod | undefined) ?? null)}
                  className="flex w-full flex-wrap gap-2"
                  aria-labelledby="settle-method-label"
                >
                  {SETTLEMENT_METHODS.map((m) => (
                    <ToggleGroupItem
                      key={m.value}
                      value={m.value}
                      variant="outline"
                      className="h-9 rounded-full px-4 aria-pressed:border-primary"
                    >
                      {m.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="settle-reference">Reference</FieldLabel>
                <Input
                  id="settle-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="e.g. UPI transaction ID"
                  className="h-11 rounded-full px-4"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="settle-note">Note</FieldLabel>
                <Textarea
                  id="settle-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="Anything worth remembering"
                  className="rounded-[20px] px-4"
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
        ) : writePending && !createExpense.isPending && !settleUp.isPending ? (
          <FieldDescription className="text-center">
            Waiting for your other changes to save…
          </FieldDescription>
        ) : null}
        <Button
          className="h-12 w-full rounded-full"
          disabled={!online || writePending}
          onClick={handleSave}
        >
          {createExpense.isPending || settleUp.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : null}
          Record payment
        </Button>
      </SheetFooter>
    </>
  );
}
