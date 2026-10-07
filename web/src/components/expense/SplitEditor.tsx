/* eslint-disable react-refresh/only-export-components */
import { useId, useState } from 'react';
import { Equal, Minus, Plus } from 'lucide-react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatMoney } from '@/lib/money';
import { properName } from '@/lib/names';
import type { User } from '@/lib/types';
import { cn } from '@/lib/utils';
import { centsToInput, currencySymbol, parseShareInput } from './money-input';

export {
  defaultSplitState,
  resolveSplit,
  splitStateFromShares,
  type SplitMode,
  type SplitResolution,
  type SplitState,
} from './split-state';
import type { SplitMode, SplitState } from './split-state';
import { resolveSplit, withSplitMode } from './split-state';

const MODES: { mode: SplitMode; label: string }[] = [
  { mode: 'equal', label: 'Equal' },
  { mode: 'unequal', label: 'Unequal' },
  { mode: 'percent', label: 'Percent' },
  { mode: 'shares', label: 'Shares' },
];

export function SplitEditor({
  participants,
  meId,
  amountCents,
  currency,
  value,
  onChange,
  showErrors = false,
  legacy = false,
  errorId,
}: {
  participants: User[];
  meId: number;
  /** Parsed total; null while the amount field is empty/invalid. */
  amountCents: number | null;
  currency: string;
  value: SplitState;
  onChange: (next: SplitState) => void;
  /** The form was submitted: show a failing split as an error right away. */
  showErrors?: boolean;
  /** Opened from stored amounts with no split method on record. */
  legacy?: boolean;
  /** id for the error/remainder line (the summary row points at it). */
  errorId?: string;
}) {
  // A remainder ("₹200 left to split") is a neutral hint until the person
  // edits a field or tries to save — never an error before they've typed.
  const [touched, setTouched] = useState(false);
  const labelId = useId();
  const edit = (next: SplitState) => {
    setTouched(true);
    onChange(next);
  };
  const ids = participants.map((p) => p.id);
  const resolved =
    amountCents !== null ? resolveSplit(value, participants, amountCents, currency) : null;
  const owedFor = (id: number) =>
    resolved?.owed ? (resolved.owed.find((o) => o.userId === id)?.owedCents ?? 0) : null;
  const nameOf = (p: User) => (p.id === meId ? 'You' : properName(p.name));
  const preview = (id: number) => {
    const owed = owedFor(id);
    if (owed === null) return null;
    return (
      <span className="text-sm text-muted-foreground tabular-nums">
        {formatMoney(owed, currency)}
      </span>
    );
  };
  const loud = touched || showErrors;

  return (
    <Field>
      <FieldLabel id={labelId}>Split</FieldLabel>
      <ToggleGroup
        value={[value.mode]}
        onValueChange={(v) => {
          if (v[0]) onChange(withSplitMode(value, v[0] as SplitMode, ids, amountCents, currency));
        }}
        className="w-full"
        aria-labelledby={labelId}
      >
        {MODES.map(({ mode, label }) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            variant="outline"
            className="h-11 min-w-0 flex-1 rounded-full aria-pressed:border-primary"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {value.mode === 'equal' ? (
        <div className="flex flex-col">
          {participants.map((p) => {
            const checked = value.equalChecked.includes(p.id);
            return (
              <label key={p.id} className="flex min-h-11 cursor-pointer items-center gap-3 py-1">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    edit({
                      ...value,
                      equalChecked: next
                        ? [...value.equalChecked, p.id]
                        : value.equalChecked.filter((id) => id !== p.id),
                    })
                  }
                  aria-label={`Include ${p.name}`}
                />
                <UserAvatar user={p} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
                {checked ? preview(p.id) : null}
              </label>
            );
          })}
        </div>
      ) : null}

      {value.mode === 'unequal' ? (
        <div className="flex flex-col gap-2">
          {legacy ? (
            <FieldDescription>
              Saved as exact amounts — the original split method wasn’t recorded.
            </FieldDescription>
          ) : null}
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
                  aria-label={`Amount owed by ${p.name}`}
                  className="text-right tabular-nums"
                  value={value.unequalRaw[p.id] ?? ''}
                  onChange={(e) =>
                    edit({
                      ...value,
                      unequalRaw: { ...value.unequalRaw, [p.id]: e.target.value },
                    })
                  }
                />
              </InputGroup>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start rounded-full"
            onClick={() => {
              // Between the people who have an amount now (or everyone).
              const charged = ids.filter(
                (id) => (parseShareInput(value.unequalRaw[id] ?? '', currency) ?? 0) > 0,
              );
              edit({ ...value, mode: 'equal', equalChecked: charged.length > 0 ? charged : ids });
            }}
          >
            <Equal data-icon="inline-start" aria-hidden="true" />
            Split equally
          </Button>
        </div>
      ) : null}

      {value.mode === 'percent' ? (
        <div className="flex flex-col gap-2">
          {participants.map((p) => (
            <div key={p.id} className="flex min-h-11 items-center gap-3">
              <UserAvatar user={p} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
              {preview(p.id)}
              <InputGroup className="h-11 w-24 rounded-full">
                <InputGroupInput
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Percentage for ${p.name}`}
                  className="text-right tabular-nums"
                  value={value.percentRaw[p.id] ?? ''}
                  onChange={(e) =>
                    edit({
                      ...value,
                      percentRaw: { ...value.percentRaw, [p.id]: e.target.value },
                    })
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>%</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </div>
          ))}
        </div>
      ) : null}

      {value.mode === 'shares' ? (
        <div className="flex flex-col gap-2">
          {participants.map((p) => {
            const count = value.shareCounts[p.id] ?? 0;
            const setCount = (next: number) =>
              edit({
                ...value,
                shareCounts: { ...value.shareCounts, [p.id]: Math.max(0, next) },
              });
            return (
              <div key={p.id} className="flex min-h-11 items-center gap-3">
                <UserAvatar user={p} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
                {preview(p.id)}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 rounded-full"
                    aria-label={`Fewer shares for ${p.name}`}
                    disabled={count === 0}
                    onClick={() => setCount(count - 1)}
                  >
                    <Minus />
                  </Button>
                  <span className="w-7 text-center text-sm tabular-nums">{count}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 rounded-full"
                    aria-label={`More shares for ${p.name}`}
                    onClick={() => setCount(count + 1)}
                  >
                    <Plus />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {amountCents === null ? (
        <FieldDescription id={errorId}>Enter the amount to preview the split.</FieldDescription>
      ) : resolved?.error ? (
        <FieldDescription id={errorId} className={cn(loud && 'text-destructive')}>
          {resolved.error}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
