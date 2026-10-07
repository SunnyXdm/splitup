/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * The mounted form body registers its "would closing now lose edits?" check
 * (and unregisters with null).
 */
export type CloseGuard = (check: (() => boolean) | null) => void;

/**
 * "Keep editing / Discard changes" for a sheet holding unsaved edits. Every
 * way out — Back, Escape, ×, the scrim — goes through `onSheetOpenChange`;
 * while `guard` says there are unsaved edits, closing asks first.
 *
 * Back is special: by the time the sheet hears about it, the browser already
 * consumed the sheet's history entry. The sheet's dismiss hook is detached for
 * one render (re-arming it pushes a fresh entry) BEFORE the confirm opens and
 * pushes its own, so Back keeps closing the top-most layer: the confirm first,
 * then the sheet.
 */
export function useCloseGuard(onOpenChange: (open: boolean) => void) {
  const check = useRef<(() => boolean) | null>(null);
  const guard: CloseGuard = useCallback((fn) => {
    check.current = fn;
  }, []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rearm, setRearm] = useState(false);
  const [confirmAfterRearm, setConfirmAfterRearm] = useState(false);
  useEffect(() => {
    // Two commits in a row on purpose: the dismiss hook must re-push the
    // sheet's history entry before the confirm pushes its own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (rearm) setRearm(false);
    else if (confirmAfterRearm) {
      setConfirmAfterRearm(false);
      setConfirmOpen(true);
    }
  }, [rearm, confirmAfterRearm]);

  const request = (next: boolean, details?: unknown) => {
    if (!next && check.current?.()) {
      // No event details = the history-dismiss hook (Back) asked.
      if (details === undefined) {
        setRearm(true);
        setConfirmAfterRearm(true);
      } else {
        setConfirmOpen(true);
      }
      return;
    }
    onOpenChange(next);
  };

  return {
    guard,
    /** Pass as the Sheet's onOpenChange. */
    onSheetOpenChange: rearm ? undefined : request,
    confirm: {
      open: confirmOpen,
      onOpenChange: setConfirmOpen,
      onDiscard: () => {
        check.current = null;
        setConfirmOpen(false);
        onOpenChange(false);
      },
    },
  };
}

export function DiscardChangesDialog({
  open,
  onOpenChange,
  onDiscard,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
  description: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-full">Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" className="rounded-full" onClick={onDiscard}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
