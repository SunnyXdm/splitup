import { useState, type ReactNode } from 'react';
import ExpenseForm from '@/components/expense/ExpenseForm';
import type { Expense, SyncData } from '@/lib/types';

/**
 * "Repeat" from the expense detail sheet: a new expense prefilled from an
 * existing one, in the same group (or direct with the same friend).
 */
export function useRepeatExpense(sync: SyncData | undefined): {
  onRepeat: (expense: Expense) => void;
  repeatForm: ReactNode;
} {
  const [source, setSource] = useState<Expense | undefined>();
  const [open, setOpen] = useState(false);
  const friendId =
    source && source.groupId === null && sync
      ? source.shares.find((s) => s.userId !== sync.me.id)?.userId
      : undefined;
  return {
    onRepeat: (expense) => {
      setSource(expense);
      setOpen(true);
    },
    repeatForm: source ? (
      <ExpenseForm
        open={open}
        onOpenChange={setOpen}
        groupId={source.groupId}
        friendId={friendId}
        repeatOf={source}
      />
    ) : null,
  };
}
