import { createContext } from 'react';
import type { HistoryScope } from '@/lib/history-rows';

/**
 * Which page an ExpenseHistory sits on (group, friend, or everything). Set by
 * the screen around its FilteredHistory, so row facts and settle-up amounts
 * read correctly in context without threading a prop through the filter UI.
 */
export const HistoryScopeContext = createContext<HistoryScope>({ kind: 'all' });
