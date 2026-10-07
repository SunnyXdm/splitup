/* eslint-disable react-refresh/only-export-components */
import { useId } from 'react';
import { UsersRound } from 'lucide-react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Field, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { PickerSelect } from '@/components/ui/picker-select';
import type { User } from '@/lib/types';
import { centsToInput, currencySymbol } from './money-input';

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
}: {
  participants: User[];
  meId: number;
  /** Parsed total; null while the amount field is empty/invalid. */
  amountCents: number | null;
  currency: string;
  value: PayerState;
  onChange: (next: PayerState) => void;
}) {
  const labelId = useId();
  const nameOf = (id: number) => {
    const u = participants.find((p) => p.id === id);
    if (!u) return 'Someone';
    return u.id === meId ? 'You' : u.name;
  };
  const selectValue = value.mode === 'multiple' ? MULTIPLE : String(value.payerId);
  const resolved =
    value.mode === 'multiple' && amountCents !== null
      ? resolvePaid(value, participants, amountCents, currency)
      : null;

  return (
    <Field>
      <span id={labelId} className="eyebrow">
        Paid by
      </span>
      <PickerSelect
        title="Who paid?"
        aria-labelledby={labelId}
        value={selectValue}
        onValueChange={(v) => {
          if (v === MULTIPLE) onChange({ ...value, mode: 'multiple' });
          else onChange({ ...value, mode: 'single', payerId: Number(v) });
        }}
        options={[
          ...participants.map((p) => ({
            value: String(p.id),
            label: p.id === meId ? 'You' : p.name,
            leading: <UserAvatar user={p} size="sm" />,
          })),
          ...(participants.length > 1
            ? [{
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
              }]
            : []),
        ]}
      />
      {value.mode === 'multiple' ? (
        <div className="flex flex-col gap-2">
          {participants.map((p) => (
            <div key={p.id} className="flex min-h-11 items-center gap-3">
              <UserAvatar user={p} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p.id)}</span>
              <InputGroup className="h-10 w-32 rounded-full">
                <InputGroupAddon>
                  <InputGroupText>{currencySymbol(currency)}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  inputMode="decimal"
                  placeholder={centsToInput(0, currency)}
                  aria-label={`Amount paid by ${p.name}`}
                  className="text-right"
                  value={value.multiRaw[p.id] ?? ''}
                  onChange={(e) =>
                    onChange({ ...value, multiRaw: { ...value.multiRaw, [p.id]: e.target.value } })
                  }
                />
              </InputGroup>
            </div>
          ))}
          {amountCents === null ? (
            <FieldDescription>Enter the total amount first.</FieldDescription>
          ) : resolved?.error ? (
            <FieldDescription className="text-destructive">{resolved.error}</FieldDescription>
          ) : (
            <FieldDescription>Payments match the total.</FieldDescription>
          )}
        </div>
      ) : null}
    </Field>
  );
}
