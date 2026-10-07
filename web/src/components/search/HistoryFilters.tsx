import { useId, useState } from 'react';
import { HandCoins, ReceiptText, Search, SearchX, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PickerSelect, type PickerOption } from '@/components/ui/picker-select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { UserAvatar } from '@/components/common/UserAvatar';
import { CATEGORIES, CATEGORY_META } from '@/lib/categories';
import {
  RANGE_LABELS,
  formatDayRange,
  hasActiveFilters,
  resolveDateRange,
  type HistoryFilters,
  type RangePreset,
} from '@/lib/search';
import type { Category, SyncData, User } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Pill-shaped filter chip: ink-filled when the filter is narrowing the list. */
function chipClass(active: boolean) {
  return cn(
    'hit-area h-9 w-auto max-w-[15rem] shrink-0 gap-1.5 border-border bg-card px-3.5 text-[13px] font-medium',
    active &&
      'border-primary bg-primary text-primary-foreground [&_svg]:text-primary-foreground/70',
  );
}

export type DateRangeValue = Pick<HistoryFilters, 'range' | 'from' | 'to'>;

/**
 * Date-range chip: presets in a bottom-sheet picker; "Custom range" opens a
 * second sheet with two date fields. Shared by history filters and summaries.
 */
export function DateRangeChip({
  value,
  onChange,
  allLabel = 'Date',
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** Chip text when no range is set. */
  allLabel?: string;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const resolved = resolveDateRange(value.range, new Date(), value.from, value.to);
  const options: PickerOption[] = (Object.keys(RANGE_LABELS) as RangePreset[]).map((r) => ({
    value: r,
    label: RANGE_LABELS[r],
    sublabel:
      r === 'all'
        ? undefined
        : r === 'custom'
          ? value.range === 'custom'
            ? formatDayRange(resolved)
            : 'Pick start and end dates'
          : formatDayRange(resolveDateRange(r, new Date())),
  }));
  const display =
    value.range === 'all'
      ? allLabel
      : value.range === 'custom'
        ? formatDayRange(resolved)
        : RANGE_LABELS[value.range];

  return (
    <>
      <PickerSelect
        title="Date range"
        aria-label="Date range"
        value={value.range}
        displayLabel={display}
        options={options}
        className={chipClass(value.range !== 'all')}
        onValueChange={(v) => {
          if (v === 'custom') setCustomOpen(true);
          else onChange({ range: v as RangePreset, from: null, to: null });
        }}
      />
      <CustomRangeSheet
        open={customOpen}
        onOpenChange={setCustomOpen}
        initial={
          value.range === 'custom'
            ? { from: resolved.from ?? '', to: resolved.to ?? '' }
            : (() => {
                const month = resolveDateRange('this-month', new Date());
                return { from: month.from ?? '', to: month.to ?? '' };
              })()
        }
        onApply={(from, to) => onChange({ range: 'custom', from, to })}
      />
    </>
  );
}

function CustomRangeSheet({
  open,
  onOpenChange,
  initial,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { from: string; to: string };
  onApply: (from: string | null, to: string | null) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-xl rounded-t-[28px]">
        <SheetHeader className="pb-0">
          <SheetTitle className="text-xl">Custom range</SheetTitle>
        </SheetHeader>
        {/* Mounted per open, so the draft resets to the current range. */}
        <CustomRangeBody
          initial={initial}
          onApply={(from, to) => {
            // Apply first: it replaces this sheet's history entry, so the
            // close below doesn't step Back over the new URL.
            onApply(from, to);
            onOpenChange(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function CustomRangeBody({
  initial,
  onApply,
}: {
  initial: { from: string; to: string };
  onApply: (from: string | null, to: string | null) => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const fromId = useId();
  const toId = useId();
  return (
    <form
      className="flex flex-col gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(from || null, to || null);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={fromId}>From</Label>
          <Input
            id={fromId}
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="h-11 rounded-full px-4"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={toId}>To</Label>
          <Input
            id={toId}
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="h-11 rounded-full px-4"
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Both days are included. Leave one empty for an open-ended range.
      </p>
      <Button type="submit" className="h-11 rounded-full" disabled={!from && !to}>
        Apply range
      </Button>
    </form>
  );
}

interface FilterBarProps {
  sync: SyncData;
  filters: HistoryFilters;
  text: string;
  onTextChange: (text: string) => void;
  onChange: (patch: Partial<HistoryFilters>) => void;
  onClear: () => void;
  /** People offered in the "Paid by" picker (besides "Anyone" and "You"). */
  people: User[];
  /** Global search only: filter by group. */
  showGroupFilter?: boolean;
  /** Matching entries, shown when any filter is active. */
  resultCount: number;
  autoFocus?: boolean;
  placeholder?: string;
}

export function HistoryFilterBar({
  sync,
  filters,
  text,
  onTextChange,
  onChange,
  onClear,
  people,
  showGroupFilter = false,
  resultCount,
  autoFocus = false,
  placeholder = 'Search description, amount, payer…',
}: FilterBarProps) {
  const inputId = useId();
  const active = hasActiveFilters(filters) || text.trim() !== '';

  const payerName = (p: HistoryFilters['payer']) =>
    p === 'any'
      ? 'Paid by'
      : p === 'me'
        ? 'Paid by you'
        : `Paid by ${people.find((u) => u.id === p)?.name ?? sync.users.find((u) => u.id === p)?.name ?? 'someone'}`;
  const groupName = (g: HistoryFilters['group']) =>
    g === 'all'
      ? 'Group'
      : g === 'direct'
        ? 'Non-group'
        : (sync.groups.find((x) => x.id === g)?.name ?? 'Group');

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Label htmlFor={inputId} className="sr-only">
          Search expenses
        </Label>
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          // Search is the whole point of the /search screen.
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text !== '') {
              e.preventDefault();
              onTextChange('');
            }
          }}
          className="bg-card dark:bg-card h-12 rounded-full border-transparent pr-12 pl-11 text-base shadow-[0_4px_24px_rgba(0,0,0,0.04)] md:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {text !== '' ? (
          <button
            type="button"
            aria-label="Clear search text"
            onClick={() => onTextChange('')}
            className="hit-area text-muted-foreground hover:bg-secondary focus-visible:ring-focus-ring absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="Filters"
        className="relative -mx-4 -mt-1 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-1 [&::-webkit-scrollbar]:hidden"
      >
        <DateRangeChip value={filters} onChange={(next) => onChange(next)} />
        <PickerSelect
          title="Paid by"
          aria-label="Paid by"
          value={String(filters.payer)}
          displayLabel={payerName(filters.payer)}
          className={chipClass(filters.payer !== 'any')}
          options={[
            { value: 'any', label: 'Anyone' },
            {
              value: 'me',
              label: 'You',
              leading: <UserAvatar user={sync.me} size="sm" />,
            },
            ...people.map((u) => ({
              value: String(u.id),
              label: u.name,
              leading: <UserAvatar user={u} size="sm" />,
            })),
          ]}
          onValueChange={(v) => onChange({ payer: v === 'any' || v === 'me' ? v : Number(v) })}
        />
        <PickerSelect
          title="Category"
          aria-label="Category"
          value={filters.category}
          displayLabel={
            filters.category === 'all' ? 'Category' : CATEGORY_META[filters.category].label
          }
          className={chipClass(filters.category !== 'all')}
          options={[
            { value: 'all', label: 'All categories' },
            ...CATEGORIES.map((c) => ({
              value: c,
              label: CATEGORY_META[c].label,
              leading: (
                <span className="bg-background flex size-7 items-center justify-center rounded-full">
                  <CategoryIcon category={c} className="text-foreground/70 size-3.5" />
                </span>
              ),
            })),
          ]}
          onValueChange={(v) => onChange({ category: v as Category | 'all' })}
        />
        <PickerSelect
          title="Show"
          aria-label="Entry type"
          value={filters.type}
          displayLabel={
            filters.type === 'all' ? 'Type' : filters.type === 'expenses' ? 'Expenses' : 'Payments'
          }
          className={chipClass(filters.type !== 'all')}
          options={[
            { value: 'all', label: 'Expenses and payments' },
            {
              value: 'expenses',
              label: 'Expenses only',
              leading: <ReceiptText className="text-muted-foreground size-4" aria-hidden="true" />,
            },
            {
              value: 'payments',
              label: 'Payments only',
              sublabel: 'Settle-ups between people',
              leading: <HandCoins className="text-muted-foreground size-4" aria-hidden="true" />,
            },
          ]}
          onValueChange={(v) => onChange({ type: v as HistoryFilters['type'] })}
        />
        {showGroupFilter ? (
          <PickerSelect
            title="Group"
            aria-label="Group"
            value={String(filters.group)}
            displayLabel={groupName(filters.group)}
            className={chipClass(filters.group !== 'all')}
            options={[
              { value: 'all', label: 'All groups' },
              {
                value: 'direct',
                label: 'Non-group',
                sublabel: 'Expenses directly with friends',
                leading: <Users className="text-muted-foreground size-4" aria-hidden="true" />,
              },
              ...sync.groups.map((g) => ({
                value: String(g.id),
                label: g.name,
                leading: (
                  <span
                    className="flex size-7 items-center justify-center text-lg"
                    aria-hidden="true"
                  >
                    {g.emoji}
                  </span>
                ),
              })),
            ]}
            onValueChange={(v) =>
              onChange({ group: v === 'all' || v === 'direct' ? v : Number(v) })
            }
          />
        ) : null}
      </div>

      {active ? (
        <div className="flex min-h-8 items-center justify-between gap-3 px-1">
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {resultCount === 0
              ? 'No matches'
              : `${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`}
          </p>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onClear}>
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="bg-card flex flex-col items-center gap-3 rounded-[28px] px-6 py-12 text-center">
      <span className="bg-background text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <SearchX className="size-5" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Nothing matches</p>
        <p className="text-muted-foreground text-sm">
          Try a different word or amount, or loosen the filters.
        </p>
      </div>
      <Button variant="outline" className="rounded-full" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
