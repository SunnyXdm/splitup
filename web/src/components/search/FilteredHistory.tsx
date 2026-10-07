import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import ExpenseHistory from '@/components/group/ExpenseHistory';
import { HistoryFilterBar, NoMatches } from '@/components/search/HistoryFilters';
import { compareHistory, filterExpenses, filtersToParams } from '@/lib/search';
import type { Expense, SyncData, User } from '@/lib/types';
import { useHistoryFilters } from '@/lib/use-history-filters';

/** Rows rendered per page — long histories grow on demand, not all at once. */
const PAGE = 150;

interface FilteredHistoryProps {
  sync: SyncData;
  /** The full, unfiltered history (stable per sync snapshot, ideally). */
  expenses: Expense[];
  people: User[];
  onSelect?: (expense: Expense) => void;
  showGroupTag?: boolean;
  /** Fold each settle-up's rows into one receipt entry (friend history). */
  collapseBatches?: boolean;
  showGroupFilter?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Shown instead of everything when there is no history at all. */
  empty?: ReactNode;
}

/**
 * Search field + filter chips over an ExpenseHistory. Filters only narrow
 * what is LISTED — balances elsewhere always use the full dataset.
 */
export default function FilteredHistory({
  sync,
  expenses,
  people,
  onSelect,
  showGroupTag,
  collapseBatches,
  showGroupFilter,
  autoFocus,
  placeholder,
  empty,
}: FilteredHistoryProps) {
  const { filters, text, setText, update, clear } = useHistoryFilters();

  // O(n) filter + O(n log n) sort, once per snapshot/filter change.
  const sorted = useMemo(
    () => [...filterExpenses(sync, expenses, filters)].sort(compareHistory),
    [sync, expenses, filters],
  );

  // Back to the first page whenever the filters change.
  const filterKey = filtersToParams(filters).toString();
  const [page, setPage] = useState({ key: filterKey, limit: PAGE });
  const limit = page.key === filterKey ? page.limit : PAGE;
  const visible = useMemo(() => sorted.slice(0, limit), [sorted, limit]);

  if (expenses.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="flex flex-col gap-4">
      <HistoryFilterBar
        sync={sync}
        filters={filters}
        text={text}
        onTextChange={setText}
        onChange={update}
        onClear={clear}
        people={people}
        showGroupFilter={showGroupFilter}
        resultCount={sorted.length}
        countFor={(f) => filterExpenses(sync, expenses, { ...f, q: filters.q }).length}
        autoFocus={autoFocus}
        placeholder={placeholder}
      />
      {sorted.length === 0 ? (
        <NoMatches onClear={clear} />
      ) : (
        <>
          <ExpenseHistory
            sync={sync}
            expenses={visible}
            onSelect={onSelect}
            showGroupTag={showGroupTag}
            collapseBatches={collapseBatches}
          />
          {sorted.length > visible.length ? (
            <Button
              variant="outline"
              className="h-11 rounded-full"
              onClick={() => setPage({ key: filterKey, limit: limit + PAGE })}
            >
              Show more ({sorted.length - visible.length} older)
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
