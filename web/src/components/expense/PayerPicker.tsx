/* eslint-disable react-refresh/only-export-components */
import { useId, useState } from 'react';
import { UsersRound } from 'lucide-react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Field, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import { properName } from '@/lib/names';
import type { User } from '@/lib/types';
import { cn } from '@/lib/utils';
import { centsToInput, currencySymbol, parseShareInput } from './money-input';

export {
  defaultPayerState,
  payerStateFromShares,
  resolvePaid,
  type PaidResolution,
  type PayerState,
} from './payer-state';
import { resolvePaid, type PayerState } from './payer-state';

const MULTIPLE = 'multiple';

export function PayerPicker({
  participants,
  meId,
  amountCents,
  currency,
  value,
  onChange,
  showErrors = false,
  errorId,
}: {
  participants: User[];
  meId: number;
  /** Parsed total; null while the amount field is empty/invalid. */
  amountCents: number | null;
  currency: string;
  value: PayerState;
  onChange: (next: PayerState) => void;
  /** The form was submitted: show a mismatch as an error right away. */
  showErrors?: boolean;
  /** id for the error/remainder line (the summary row points at it). */
  errorId?: string;
}) {
  const labelId = useId();
  // Like the split: a remainder is a hint until someone edits or saves.
  const [touched, setTouched] = useState(false);
  const nameOf = (u: User) => (u.id === meId ? 'You' : properName(u.name));
  const selectValue = value.mode === 'multiple' ? MULTIPLE : String(value.payerId);
  const resolved =
    value.mode === 'multiple' && amountCents !== null
      ? resolvePaid(value, participants, amountCents, currency)
      : null;

  const toMultiple = () => {
    // Start from what was true a moment ago: the single payer paid it all.
    const empty = participants.every(
      (p) => !(parseShareInput(value.multiRaw[p.id] ?? '', currency) ?? 0),
    );
    const multiRaw =
      empty && amountCents !== null
        ? { [value.payerId]: centsToInput(amountCents, currency) }
        : value.multiRaw;
    onChange({ ...value, mode: 'multiple', multiRaw });
  };

  return (
    <Field>
      <span id={labelId} className="text-sm leading-snug font-medium">
        Paid by
      </span>
      <PickerSelect
        title="Who paid?"
        aria-labelledby={labelId}
        value={selectValue}
        onValueChange={(v) => {
          if (v === MULTIPLE) toMultiple();
          else onChange({ ...value, mode: 'single', payerId: Number(v) });
        }}
        options={[
          ...participants.map((p) => ({
            value: String(p.id),
            label: nameOf(p),
            leading: <UserAvatar user={p} size="sm" />,
          })),
          ...(participants.length > 1
            ? [
                {
                  value: MULTIPLE,
                  label: 'Multiple people',
                  leading: (
                    <span
                      aria-hidden="true"
                      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background"
                    >
                      <UsersRound className="size-3.5" />
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {value.mode === 'multiple' ? (
        <div className="flex flex-col gap-2">
          {participants.map((p) => (
            <div key={p.id} className="flex min-h-11 items-center gap-3">
              <UserAvatar user={p} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
              <InputGroup className="h-11 w-36 rounded-full">
                <InputGroupAddon>
                  <InputGroupText>{currencySymbol(currency)}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  inputMode="decimal"
                  placeholder={centsToInput(0, currency)}
                  aria-label={`Amount paid by ${p.name}`}
                  className="text-right tabular-nums"
                  value={value.multiRaw[p.id] ?? ''}
                  onChange={(e) => {
                    setTouched(true);
                    onChange({ ...value, multiRaw: { ...value.multiRaw, [p.id]: e.target.value } });
                  }}
                />
              </InputGroup>
            </div>
          ))}
          {amountCents === null ? (
            <FieldDescription id={errorId}>Enter the total amount first.</FieldDescription>
          ) : resolved?.error ? (
            <FieldDescription
              id={errorId}
              className={cn((touched || showErrors) && 'text-destructive')}
            >
              {resolved.error}
            </FieldDescription>
          ) : (
            <FieldDescription>Payments match the total.</FieldDescription>
          )}
        </div>
      ) : null}
    </Field>
  );
}
