import { useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { toast } from 'sonner';
import { useOnline } from '@/components/layout/OfflineBanner';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ApiError } from '@/lib/api';
import { formatMoney, parseAmountToCents } from '@/lib/money';
import { useCreateExpense, useSettleUp, useSyncData } from '@/lib/queries';
import { apportionSettle, pairConstituents, settlementWatermark } from '@/lib/settle';
import type { ExpenseInput, User } from '@/lib/types';
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
  currency,
  direction: initialDirection,
}: Omit<SettleUpSheetProps, 'open'>) {
  const { data: sync } = useSyncData();
  const online = useOnline();
  const createExpense = useCreateExpense();
  const settleUp = useSettleUp();

  const [direction, setDirection] = useState<Direction>(initialDirection ?? 'i_paid');
  const [counterpartyId, setCounterpartyId] = useState<number | null>(toUserId ?? null);
  const [amountRaw, setAmountRaw] = useState(
    suggestedCents !== undefined ? centsToInput(suggestedCents, currency) : '',
  );
  const [attempted, setAttempted] = useState(false);

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

  const options: User[] = useMemo(() => {
    if (!sync) return [];
    const ids =
      groupId !== null
        ? (sync.groups.find((g) => g.id === groupId)?.memberIds ?? []).filter(
            (id) => id !== sync.me.id,
          )
        : sync.friendIds;
    const pool = new Set(ids);
    if (counterpartyId !== null) pool.add(counterpartyId);
    return [...pool].map(
      (id) =>
        sync.users.find((u) => u.id === id) ?? { id, name: 'Someone', email: null, picture: null },
    );
  }, [sync, groupId, counterpartyId]);

  useEffect(() => {
    if (counterpartyId === null && options.length > 0) setCounterpartyId(options[0].id);
  }, [counterpartyId, options]);

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
  const counterparty = options.find((u) => u.id === counterpartyId) ?? null;
  const amountError = amountCents === null ? 'Enter a valid amount.' : null;
  const counterpartyError = counterparty === null ? 'Choose who you settled with.' : null;

  const celebrate = () => {
    toast('Payment recorded');
    // The delight moment: this payment cleared the suggested balance exactly.
    if (
      suggestedCents !== undefined &&
      amountCents === suggestedCents &&
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

  const handleSave = () => {
    setAttempted(true);
    if (amountCents === null || counterparty === null) return;

    if (groupId === null) {
      // Friend mode: record the apportioned rows atomically.
      if (settleRows.length === 0) return;
      settleUp.mutate(
        {
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
        },
        {
          onSuccess: celebrate,
          onError: (err: Error) => {
            if (err instanceof ApiError && err.status === 409) {
              // Balances moved under us; the sheet stays open and the
              // breakdown recomputes from the refetched data.
              toast.error('Balances changed — review the updated amounts and try again.');
            } else {
              toast.error(err.message);
            }
          },
        },
      );
      return;
    }

    const payerId = direction === 'i_paid' ? me.id : counterparty.id;
    const recipientId = direction === 'i_paid' ? counterparty.id : me.id;
    const input: ExpenseInput = {
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
    };
    createExpense.mutate(input, {
      onSuccess: celebrate,
      onError: (err: Error) => toast.error(err.message),
    });
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
            <FieldLabel htmlFor="settle-with">
              {direction === 'i_paid' ? 'To' : 'From'}
            </FieldLabel>
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
                    r.payerId === me.id ? `You → ${counterparty.name}` : `${counterparty.name} → You`;
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
          disabled={!online || createExpense.isPending || settleUp.isPending}
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
