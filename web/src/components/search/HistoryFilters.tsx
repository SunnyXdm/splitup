import { useId, useState, type ReactNode } from 'react';
import {
  HandCoins,
  ReceiptText,
  Search,
  SearchX,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PickerSelect, type PickerOption } from '@/components/ui/picker-select';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { CategoryIcon } from '@/components/common/CategoryIcon';
import { UserAvatar } from '@/components/common/UserAvatar';
import { CATEGORIES, CATEGORY_META } from '@/lib/categories';
import {
  DEFAULT_FILTERS,
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
  className,
  labelledBy,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** Chip text when no range is set. */
  allLabel?: string;
  /** Trigger styling (default: a filter chip). */
  className?: string;
  /** id of a visible label (else the trigger is named "Date range"). */
  labelledBy?: string;
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
        aria-label={labelledBy ? undefined : 'Date range'}
        aria-labelledby={labelledBy}
        value={value.range}
        displayLabel={display}
        options={options}
        className={className ?? chipClass(value.range !== 'all')}
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
  /** Matches for a not-yet-applied set of filters (the Filters sheet's button). */
  countFor?: (filters: HistoryFilters) => number;
  autoFocus?: boolean;
  placeholder?: string;
}

type FilterKey = 'range' | 'payer' | 'category' | 'type' | 'group';

/** How many of the (non-text) filters are narrowing the list. */
function activeFilterCount(f: HistoryFilters, showGroupFilter: boolean): number {
  const on: Record<FilterKey, boolean> = {
    range: f.range !== 'all',
    payer: f.payer !== 'any',
    category: f.category !== 'all',
    type: f.type !== 'all',
    group: showGroupFilter && f.group !== 'all',
  };
  return Object.values(on).filter(Boolean).length;
}

/** Option lists and labels shared by the quick chips and the Filters sheet. */
function filterOptions(sync: SyncData, people: User[]) {
  const payerName = (p: HistoryFilters['payer']) =>
    p === 'me'
      ? 'You'
      : (people.find((u) => u.id === p)?.name ??
        sync.users.find((u) => u.id === p)?.name ??
        'someone');
  const groupName = (g: HistoryFilters['group']) =>
    g === 'direct' ? 'Non-group' : (sync.groups.find((x) => x.id === g)?.name ?? 'Group');
  const payer: PickerOption[] = [
    { value: 'any', label: 'Anyone' },
    { value: 'me', label: 'You', leading: <UserAvatar user={sync.me} size="sm" /> },
    ...people.map((u) => ({
      value: String(u.id),
      label: u.name,
      leading: <UserAvatar user={u} size="sm" />,
    })),
  ];
  const category: PickerOption[] = [
    { value: 'all', label: 'All categories' },
    ...CATEGORIES.map((c) => ({
      value: c,
      label: CATEGORY_META[c].label,
      leading: (
        <span className="flex size-7 items-center justify-center rounded-full bg-background">
          <CategoryIcon category={c} className="size-3.5 text-foreground/70" />
        </span>
      ),
    })),
  ];
  const type: PickerOption[] = [
    { value: 'all', label: 'Expenses and payments' },
    {
      value: 'expenses',
      label: 'Expenses only',
      leading: <ReceiptText className="size-4 text-muted-foreground" aria-hidden="true" />,
    },
    {
      value: 'payments',
      label: 'Payments only',
      sublabel: 'Settle-ups between people',
      leading: <HandCoins className="size-4 text-muted-foreground" aria-hidden="true" />,
    },
  ];
  const group: PickerOption[] = [
    { value: 'all', label: 'All groups' },
    {
      value: 'direct',
      label: 'Non-group',
      sublabel: 'Expenses directly with friends',
      leading: <Users className="size-4 text-muted-foreground" aria-hidden="true" />,
    },
    ...sync.groups.map((g) => ({
      value: String(g.id),
      label: g.name,
      leading: (
        <span className="flex size-7 items-center justify-center text-lg" aria-hidden="true">
          {g.emoji}
        </span>
      ),
    })),
  ];
  const typeName = (t: HistoryFilters['type']) =>
    t === 'expenses' ? 'Expenses' : t === 'payments' ? 'Payments' : 'Type';
  const parsePayer = (v: string): HistoryFilters['payer'] =>
    v === 'any' || v === 'me' ? v : Number(v);
  const parseGroup = (v: string): HistoryFilters['group'] =>
    v === 'all' || v === 'direct' ? v : Number(v);
  return { payer, category, type, group, payerName, groupName, typeName, parsePayer, parseGroup };
}

/**
 * Search field, an always-visible "Filters" button (with how many are on)
 * that opens every filter in one sheet, and quick chips for the common ones
 * beside it (they scroll sideways inside their own row, never the page).
 */
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
  countFor,
  autoFocus = false,
  placeholder = 'Search description, amount, payer…',
}: FilterBarProps) {
  const inputId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const active = hasActiveFilters(filters) || text.trim() !== '';
  const count = activeFilterCount(filters, showGroupFilter);
  const o = filterOptions(sync, people);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Label htmlFor={inputId} className="sr-only">
          Search expenses
        </Label>
        <Search
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
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
          className="h-12 rounded-full border-transparent bg-card pr-12 pl-11 text-base shadow-level-1 md:text-sm dark:bg-card [&::-webkit-search-cancel-button]:hidden"
        />
        {text !== '' ? (
          <button
            type="button"
            aria-label="Clear search text"
            onClick={() => onTextChange('')}
            className="hit-area absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label={count > 0 ? `Filters, ${count} on` : 'Filters'}
          onClick={() => setSheetOpen(true)}
          className={cn(
            'hit-area relative flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-focus-ring',
            count > 0
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card hover:bg-muted',
          )}
        >
          <SlidersHorizontal className="size-4" aria-hidden="true" />
          Filters
          {count > 0 ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground px-1.5 text-xs font-semibold text-primary tabular-nums">
              {count}
            </span>
          ) : null}
        </button>
        <div
          role="group"
          aria-label="Quick filters"
          className="relative -mr-4 flex min-w-0 flex-1 [scrollbar-width:none] gap-2 overflow-x-auto py-1 pr-4 [&::-webkit-scrollbar]:hidden"
        >
          <DateRangeChip value={filters} onChange={(next) => onChange(next)} />
          <PickerSelect
            title="Paid by"
            aria-label="Paid by"
            value={String(filters.payer)}
            displayLabel={filters.payer === 'any' ? 'Paid by' : `Paid by ${o.payerName(filters.payer)}`}
            className={chipClass(filters.payer !== 'any')}
            options={o.payer}
            onValueChange={(v) => onChange({ payer: o.parsePayer(v) })}
          />
          <PickerSelect
            title="Category"
            aria-label="Category"
            value={filters.category}
            displayLabel={
              filters.category === 'all' ? 'Category' : CATEGORY_META[filters.category].label
            }
            className={chipClass(filters.category !== 'all')}
            options={o.category}
            onValueChange={(v) => onChange({ category: v as Category | 'all' })}
          />
        </div>
      </div>

      {active ? (
        <div className="flex min-h-8 items-center justify-between gap-3 px-1">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {resultCount === 0
              ? 'No matches'
              : `${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`}
          </p>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onClear}>
            Clear all
          </Button>
        </div>
      ) : null}

      <FiltersSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        sync={sync}
        people={people}
        filters={filters}
        showGroupFilter={showGroupFilter}
        countFor={countFor}
        onApply={(next) => onChange(next)}
      />
    </div>
  );
}

/**
 * Every filter in one sheet. Picks stay local until "Show N results", which
 * applies them as one change (one history entry; Back undoes it).
 */
function FiltersSheet({
  open,
  onOpenChange,
  ...body
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<FiltersBodyProps, 'onDone'>) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[92dvh] w-full max-w-xl gap-0 rounded-t-card"
      >
        <SheetHeader className="pr-14">
          <SheetTitle className="text-xl">Filters</SheetTitle>
        </SheetHeader>
        {/* Mounted per open, so the draft starts from the applied filters. */}
        <FiltersBody {...body} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

interface FiltersBodyProps {
  sync: SyncData;
  people: User[];
  filters: HistoryFilters;
  showGroupFilter: boolean;
  countFor?: (filters: HistoryFilters) => number;
  onApply: (next: Partial<HistoryFilters>) => void;
  onDone: () => void;
}

function FiltersBody({
  sync,
  people,
  filters,
  showGroupFilter,
  countFor,
  onApply,
  onDone,
}: FiltersBodyProps) {
  const [draft, setDraft] = useState(filters);
  const o = filterOptions(sync, people);
  const patch = (p: Partial<HistoryFilters>) => setDraft((d) => ({ ...d, ...p }));
  const count = countFor?.(draft);
  const changed = activeFilterCount(draft, showGroupFilter) > 0;
  const ids = {
    date: useId(),
    payer: useId(),
    category: useId(),
    type: useId(),
    group: useId(),
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        // Apply first: it replaces this sheet's history entry, so the close
        // below doesn't step Back over the new URL.
        const { range, from, to, payer, category, type, group } = draft;
        onApply({ range, from, to, payer, category, type, group });
        onDone();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-2">
        <FilterField id={ids.date} label="Date">
          <DateRangeChip
            value={draft}
            onChange={patch}
            allLabel="All time"
            className={rowPickerClass}
            labelledBy={ids.date}
          />
        </FilterField>
        <FilterField id={ids.payer} label="Paid by">
          <PickerSelect
            title="Paid by"
            aria-labelledby={ids.payer}
            value={String(draft.payer)}
            displayLabel={draft.payer === 'any' ? 'Anyone' : o.payerName(draft.payer)}
            className={rowPickerClass}
            options={o.payer}
            onValueChange={(v) => patch({ payer: o.parsePayer(v) })}
          />
        </FilterField>
        <FilterField id={ids.category} label="Category">
          <PickerSelect
            title="Category"
            aria-labelledby={ids.category}
            value={draft.category}
            className={rowPickerClass}
            options={o.category}
            onValueChange={(v) => patch({ category: v as Category | 'all' })}
          />
        </FilterField>
        <FilterField id={ids.type} label="Type">
          <PickerSelect
            title="Show"
            aria-labelledby={ids.type}
            value={draft.type}
            className={rowPickerClass}
            options={o.type}
            onValueChange={(v) => patch({ type: v as HistoryFilters['type'] })}
          />
        </FilterField>
        {showGroupFilter ? (
          <FilterField id={ids.group} label="Group">
            <PickerSelect
              title="Group"
              aria-labelledby={ids.group}
              value={String(draft.group)}
              displayLabel={draft.group === 'all' ? 'All groups' : o.groupName(draft.group)}
              className={rowPickerClass}
              options={o.group}
              onValueChange={(v) => patch({ group: o.parseGroup(v) })}
            />
          </FilterField>
        ) : null}
      </div>
      <SheetFooter className="pt-2 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <Button type="submit" size="cta" className="w-full">
          {count === undefined
            ? 'Apply filters'
            : count === 0
              ? 'No matches — apply anyway'
              : `Show ${count} ${count === 1 ? 'result' : 'results'}`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="pill"
          className="w-full"
          disabled={!changed}
          onClick={() =>
            setDraft((d) => ({ ...DEFAULT_FILTERS, q: d.q }))
          }
        >
          Reset filters
        </Button>
      </SheetFooter>
    </form>
  );
}

const rowPickerClass = 'h-12 bg-card text-base md:text-sm dark:bg-card';

function FilterField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="px-1 text-sm font-medium">
        {label}
      </span>
      {children}
    </div>
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="bg-card flex flex-col items-center gap-3 rounded-card px-6 py-12 text-center">
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
