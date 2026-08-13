import { useEffect, useRef } from 'react';

interface OverlayState {
  __overlay: true;
}

const isOverlayState = (state: unknown): state is OverlayState =>
  typeof state === 'object' && state !== null && '__overlay' in state;

/**
 * Browser-history integration for overlays (sheets, dialogs, menus, selects):
 * pressing Back while one is open must CLOSE it — top-most first when several
 * are stacked — not navigate away. On open we push a same-URL history entry;
 * popstate closes only the TOP overlay; closing by any other means consumes
 * the pushed entry without disturbing the overlays underneath.
 */

interface StackEntry {
  close: () => void;
  /** Set when Back consumed this overlay's history entry. */
  poppedByBack: boolean;
}

const stack: StackEntry[] = [];
/** Programmatic history.back() calls we must not treat as user Back presses. */
let suppressedPops = 0;

function handlePopstate() {
  if (suppressedPops > 0) {
    suppressedPops -= 1;
    return;
  }
  const top = stack.pop();
  if (top) {
    top.poppedByBack = true;
    top.close();
  }
}

export function useHistoryDismiss(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): void {
  const closeRef = useRef(onOpenChange);
  closeRef.current = onOpenChange;

  useEffect(() => {
    if (!open || !closeRef.current) return;

    const entry: StackEntry = {
      close: () => closeRef.current?.(false),
      poppedByBack: false,
    };
    window.history.pushState({ __overlay: true } satisfies OverlayState, '');
    stack.push(entry);
    if (stack.length === 1) window.addEventListener('popstate', handlePopstate);

    return () => {
      const index = stack.indexOf(entry);
      if (index !== -1) stack.splice(index, 1);
      if (stack.length === 0) window.removeEventListener('popstate', handlePopstate);
      // Closed by tap-outside/X/Escape/value-pick: consume the entry we
      // pushed — silently, so overlays beneath us are untouched. Skip if the
      // app navigated meanwhile (our entry is no longer on top) — going back
      // would eat that navigation.
      if (!entry.poppedByBack && isOverlayState(window.history.state)) {
        suppressedPops += 1;
        window.history.back();
      }
    };
  }, [open]);
}
