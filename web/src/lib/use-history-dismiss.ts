import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router';

interface OverlayState {
  /** Unique per pushed entry, so we know which overlay owns it. */
  __overlay: number;
}

const isOverlayState = (state: unknown): state is OverlayState =>
  typeof state === 'object' && state !== null && '__overlay' in state;

/**
 * Browser-history integration for overlays (sheets, dialogs, menus, selects):
 * pressing Back while one is open must CLOSE it — top-most first when several
 * are stacked — not navigate away. On open we push a same-URL history entry;
 * popstate closes only the TOP overlay; closing by any other means consumes
 * the pushed entry without disturbing the overlays underneath.
 *
 * Two subtleties:
 * - A programmatic history.back() lands asynchronously. Until every such pop
 *   has been consumed we keep listening (even with no overlay open) — else a
 *   quick close-then-reopen leaves a stale "ignore the next pop" behind and
 *   the user's next real Back press gets swallowed. Overlays opened while
 *   pops are outstanding push their entry only once the pops have drained.
 * - Navigating while an overlay is open (close + navigate in one handler)
 *   would strand the overlay entry under the new page. useOverlayNavigate
 *   REPLACES the overlay entry instead of pushing past it.
 */

interface StackEntry {
  id: number;
  close: () => void;
  /** Whether this overlay's history entry has been pushed yet. */
  pushed: boolean;
  /** Set when Back consumed this overlay's history entry. */
  poppedByBack: boolean;
}

const stack: StackEntry[] = [];
/** Programmatic history.back() calls we must not treat as user Back presses. */
let suppressedPops = 0;
let listening = false;
let nextId = 1;

function pushEntry(entry: StackEntry) {
  // Carry the router's own state (key, idx, usr) so the overlay entry reads
  // as the SAME location to react-router — its index math stays intact.
  const base = window.history.state as Record<string, unknown> | null;
  window.history.pushState({ ...(base ?? {}), __overlay: entry.id } satisfies OverlayState, '');
  entry.pushed = true;
}

function syncListener() {
  const needed = stack.length > 0 || suppressedPops > 0;
  if (needed && !listening) window.addEventListener('popstate', handlePopstate);
  if (!needed && listening) window.removeEventListener('popstate', handlePopstate);
  listening = needed;
}

function handlePopstate() {
  if (suppressedPops > 0) {
    suppressedPops -= 1;
    if (suppressedPops === 0) {
      for (const entry of stack) if (!entry.pushed) pushEntry(entry);
    }
    syncListener();
    return;
  }
  const top = stack.pop();
  if (top) {
    top.poppedByBack = true;
    top.close();
  }
  syncListener();
}

export function useHistoryDismiss(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
): void {
  const closeRef = useRef(onOpenChange);
  useLayoutEffect(() => {
    closeRef.current = onOpenChange;
  });
  const controlled = onOpenChange !== undefined;

  useEffect(() => {
    if (!open || !controlled) return;

    const entry: StackEntry = {
      id: nextId++,
      close: () => closeRef.current?.(false),
      pushed: false,
      poppedByBack: false,
    };
    stack.push(entry);
    if (suppressedPops === 0) pushEntry(entry);
    syncListener();

    return () => {
      const index = stack.indexOf(entry);
      if (index !== -1) stack.splice(index, 1);
      // Closed by tap-outside/X/Escape/value-pick: consume the entry we
      // pushed — silently, so overlays beneath us are untouched. Skip if the
      // app navigated meanwhile (no overlay entry on top) — going back would
      // eat that navigation.
      if (entry.pushed && !entry.poppedByBack && isOverlayState(window.history.state)) {
        suppressedPops += 1;
        window.history.back();
      }
      syncListener();
    };
  }, [open, controlled]);
}

/**
 * navigate() that is safe to call while an overlay is still open (e.g. "close
 * the dialog and go to the new group" in one handler): the overlay's history
 * entry is REPLACED by the destination instead of being stranded beneath it,
 * where a later Back would land on a dead duplicate of the old page.
 */
export function useOverlayNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      const onOverlayEntry = isOverlayState(window.history.state);
      if (onOverlayEntry) {
        // The overlay's cleanup must not history.back() over our navigation;
        // it checks for an overlay entry on top, which the replace removes.
        for (const entry of stack) entry.poppedByBack = true;
      }
      navigate(to, { ...options, replace: options?.replace || onOverlayEntry });
    },
    [navigate],
  );
}
