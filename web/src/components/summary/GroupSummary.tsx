import { DateRangeChip } from '@/components/search/HistoryFilters';
import SpendingSummary from '@/components/summary/SpendingSummary';
import { resolveDateRange } from '@/lib/search';
import { groupSummary } from '@/lib/summary';
import type { Expense, SyncData } from '@/lib/types';
import { useHistoryFilters } from '@/lib/use-history-filters';

/**
 * GroupDetail's Summary tab — "what did this trip cost me?". Shares the
 * history's date range (?range=…), so switching tabs keeps the same period.
 */
export default function GroupSummary({
  sync,
  groupId,
  onSelect,
}: {
  sync: SyncData;
  groupId: number;
  onSelect?: (expense: Expense) => void;
}) {
  const { filters, update } = useHistoryFilters();
  const range = resolveDateRange(filters.range, new Date(), filters.from, filters.to);
  const summaries = groupSummary(sync, groupId, range);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">Spending</span>
        <DateRangeChip value={filters} onChange={update} allLabel="All time" />
      </div>
      <SpendingSummary
        sync={sync}
        summaries={summaries}
        scope="group"
        onSelect={onSelect}
        emptyText={
          filters.range === 'all'
            ? 'Add an expense and the totals will show up here.'
            : 'Nothing was spent in this period — try a wider range.'
        }
      />
    </div>
  );
}
