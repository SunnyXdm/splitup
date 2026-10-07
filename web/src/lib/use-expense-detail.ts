import { useCallback, useState } from 'react';
import type { Expense, SettlementBatch, SyncData } from './types';

/**
 * State for "tap an expense → read it first" (ASTRA #6): a regular expense
 * (or a legacy, unbatched payment) opens ExpenseDetailSheet; a settle-up
 * payment opens its SettlementReceipt. Render <ExpenseDetailSheets detail={…}>
 * next to the screen's ExpenseForm; its Edit hands the expense back via onEdit.
 *
 * The selected expense/batch is kept after close so a sheet doesn't blank out
 * mid-animation.
 */
export interface ExpenseDetailState {
  expense: Expense | null;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  batch: SettlementBatch | null;
  receiptOpen: boolean;
  setReceiptOpen: (open: boolean) => void;
  /** Opens whichever sheet fits this row. */
  open: (expense: Expense) => void;
  openBatch: (batch: SettlementBatch) => void;
}

export function useExpenseDetail(sync: SyncData | undefined): ExpenseDetailState {
  const [expense, setExpense] = useState<Expense | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [batch, setBatch] = useState<SettlementBatch | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const openBatch = useCallback((b: SettlementBatch) => {
    setBatch(b);
    setReceiptOpen(true);
  }, []);

  const open = useCallback(
    (e: Expense) => {
      const known =
        e.isPayment && e.settlementBatchId != null
          ? sync?.settlementBatches?.find((b) => b.id === e.settlementBatchId)
          : undefined;
      if (known) {
        openBatch(known);
        return;
      }
      setExpense(e);
      setDetailOpen(true);
    },
    [sync, openBatch],
  );

  return {
    expense,
    detailOpen,
    setDetailOpen,
    batch,
    receiptOpen,
    setReceiptOpen,
    open,
    openBatch,
  };
}
