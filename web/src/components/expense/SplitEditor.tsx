import { Minus, Plus } from 'lucide-react';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatMoney, splitByWeights, splitEqual, type OwedSplit } from '@/lib/money';
import type { ExpenseShare, User } from '@/lib/types';
import {
  centsToInput,
  currencySymbol,
  formatBp,
  parsePercentInput,
  parseShareInput,
} from './money-input';

export type SplitMode = 'equal' | 'unequal' | 'percent' | 'shares';

export interface SplitState {
  mode: SplitMode;
  /** userIds included in an equal split. */
  equalChecked: number[];
  /** Raw amount input per userId (unequal mode). */
  unequalRaw: Record<number, string>;
  /** Raw percent input per userId (percent mode). */
  percentRaw: Record<number, string>;
  /** Integer share count per userId (shares mode). */
  shareCounts: Record<number, number>;
}

export function defaultSplitState(participantIds: number[]): SplitState {
  return {
    mode: 'equal',
    equalChecked: [...participantIds],
    unequalRaw: {},
    percentRaw: {},
    shareCounts: Object.fromEntries(participantIds.map((id) => [id, 1])),
  };
}

/**
 * Rebuild editor state from an existing expense (edit mode): the Unequal tab
 * is preloaded with the stored owedCents so edits start from exact values.
 */
export function splitStateFromShares(
  shares: ExpenseShare[],
  participantIds: number[],
  currency: string,
): SplitState {
  const unequalRaw: Record<number, string> = {};
  const equalChecked: number[] = [];
  for (const id of participantIds) {
    const owed = shares.find((s) => s.userId === id)?.owedCents ?? 0;
    unequalRaw[id] = owed > 0 ? centsToInput(owed, currency) : '';
    if (owed > 0) equalChecked.push(id);
  }
  return {
    mode: 'unequal',
    equalChecked: equalChecked.length > 0 ? equalChecked : [...participantIds],
    unequalRaw,
    percentRaw: {},
    shareCounts: Object.fromEntries(participantIds.map((id) => [id, 1])),
  };
}

export type SplitResolution =
  | { owed: OwedSplit[]; error: null }
  | { owed: null; error: string };

/** Turn editor state into owed shares, or a human-readable failing rule. */
export function resolveSplit(
  state: SplitState,
  participants: User[],
  amountCents: number,
  currency: string,
): SplitResolution {
  switch (state.mode) {
    case 'equal': {
      const checked = participants
        .map((p) => p.id)
        .filter((id) => state.equalChecked.includes(id))
        .sort((a, b) => a - b);
      if (checked.length === 0) {
        return { owed: null, error: 'Pick at least one person to split with.' };
      }
      return { owed: splitEqual(amountCents, checked), error: null };
    }
    case 'unequal': {
      const owed: OwedSplit[] = [];
      let sum = 0;
      for (const p of participants) {
        const cents = parseShareInput(state.unequalRaw[p.id] ?? '', currency);
        if (cents === null) return { owed: null, error: `Check ${p.name}'s amount.` };
        owed.push({ userId: p.id, owedCents: cents });
        sum += cents;
      }
      if (sum !== amountCents) {
        const diff = amountCents - sum;
        return {
          owed: null,
          error:
            diff > 0
              ? `${formatMoney(diff, currency)} left to split.`
              : `${formatMoney(-diff, currency)} over the total.`,
        };
      }
      return { owed, error: null };
    }
    case 'percent': {
      let sumBp = 0;
      const entries: { userId: number; weight: number }[] = [];
      for (const p of participants) {
        const bp = parsePercentInput(state.percentRaw[p.id] ?? '');
        if (bp === null) return { owed: null, error: `Check ${p.name}'s percentage.` };
        sumBp += bp;
        if (bp > 0) entries.push({ userId: p.id, weight: bp });
      }
      if (sumBp !== 10_000) {
        const diff = 10_000 - sumBp;
        return {
          owed: null,
          error: diff > 0 ? `${formatBp(diff)}% left to assign.` : `${formatBp(-diff)}% over 100.`,
        };
      }
      return { owed: splitByWeights(amountCents, entries), error: null };
    }
    case 'shares': {
      const entries = participants
        .map((p) => ({ userId: p.id, weight: state.shareCounts[p.id] ?? 0 }))
        .filter((e) => e.weight > 0);
      if (entries.length === 0) return { owed: null, error: 'Give at least one share.' };
      return { owed: splitByWeights(amountCents, entries), error: null };
    }
  }
}

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
}: {
  participants: User[];
  meId: number;
  /** Parsed total; null while the amount field is empty/invalid. */
  amountCents: number | null;
  currency: string;
  value: SplitState;
  onChange: (next: SplitState) => void;
}) {
  const resolved =
    amountCents !== null ? resolveSplit(value, participants, amountCents, currency) : null;
  const owedFor = (id: number) =>
    resolved?.owed ? (resolved.owed.find((o) => o.userId === id)?.owedCents ?? 0) : null;
  const nameOf = (p: User) => (p.id === meId ? 'You' : p.name);
  const preview = (id: number) => {
    const owed = owedFor(id);
    if (owed === null) return null;
    return (
      <span className="text-sm text-muted-foreground tabular-nums">
        {formatMoney(owed, currency)}
      </span>
    );
  };

  return (
    <Field>
      <span className="eyebrow">Split</span>
      <ToggleGroup
        value={[value.mode]}
        onValueChange={(v) => {
          if (v[0]) onChange({ ...value, mode: v[0] as SplitMode });
        }}
        className="w-full"
        aria-label="Split method"
      >
        {MODES.map(({ mode, label }) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            variant="outline"
            className="h-10 min-w-0 flex-1 rounded-full aria-pressed:border-primary"
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
                    onChange({
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
          {participants.map((p) => (
            <div key={p.id} className="flex min-h-11 items-center gap-3">
              <UserAvatar user={p} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
              <InputGroup className="h-10 w-32 rounded-full">
                <InputGroupAddon>
                  <InputGroupText>{currencySymbol(currency)}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  inputMode="decimal"
                  placeholder={centsToInput(0, currency)}
                  aria-label={`Amount owed by ${p.name}`}
                  className="text-right"
                  value={value.unequalRaw[p.id] ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      unequalRaw: { ...value.unequalRaw, [p.id]: e.target.value },
                    })
                  }
                />
              </InputGroup>
            </div>
          ))}
        </div>
      ) : null}

      {value.mode === 'percent' ? (
        <div className="flex flex-col gap-2">
          {participants.map((p) => (
            <div key={p.id} className="flex min-h-11 items-center gap-3">
              <UserAvatar user={p} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(p)}</span>
              {preview(p.id)}
              <InputGroup className="h-10 w-24 rounded-full">
                <InputGroupInput
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`Percentage for ${p.name}`}
                  className="text-right"
                  value={value.percentRaw[p.id] ?? ''}
                  onChange={(e) =>
                    onChange({
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
              onChange({
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
        <FieldDescription>Enter the amount to preview the split.</FieldDescription>
      ) : resolved?.error ? (
        <FieldDescription className="text-destructive">{resolved.error}</FieldDescription>
      ) : null}
    </Field>
  );
}
