import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Router, UNSAFE_createBrowserHistory as createBrowserHistory } from 'react-router';
import { routeTransitionKind, startRouteTransition } from '@/lib/view-transitions';

type RouterState = Pick<ReturnType<typeof createBrowserHistory>, 'action' | 'location'>;

/** Scroll offsets of pages left behind, by history entry key (restored on POP). */
const savedScroll = new Map<string, number>();
const SAVED_SCROLL_MAX = 100;

function saveScroll(key: string) {
  savedScroll.delete(key);
  savedScroll.set(key, window.scrollY);
  // Bounded: drop the oldest entries (Map keeps insertion order).
  for (const old of savedScroll.keys()) {
    if (savedScroll.size <= SAVED_SCROLL_MAX) break;
    savedScroll.delete(old);
  }
}

/**
 * BrowserRouter, plus page view transitions. Same history and Router as
 * BrowserRouter; the difference is how a location change is committed: when
 * the path changes, the commit runs inside document.startViewTransition so the
 * old page can slide/fade out under the new one. Direction comes from the
 * history action (Back/Forward POPs carry a delta). Same-path changes — search
 * params, and the same-URL entries overlays push for Back-to-close — commit
 * without a transition, exactly like BrowserRouter.
 *
 * Scroll: a new page (PUSH, or a REPLACE that changes the path — e.g. "create
 * group, then open it" from a sheet) starts at the top; Back / Forward (POP)
 * restores where that page was left. Search-param updates (typing, filters,
 * tabs) and overlay entries keep the path, so they never move the scroll. Applied in a layout effect
 * on commit — inside the view-transition update callback when one runs, so
 * the new snapshot is already at its final scroll. Same-path entries (search
 * params, overlay Back-to-close entries) never touch scroll.
 */
/**
 * Screen readers: after a page change, move focus to the new page's H1 (made
 * programmatically focusable, no visible ring, no scroll jump) — unless an
 * overlay or a field already holds focus.
 */
function focusPageHeading() {
  const active = document.activeElement;
  if (active && active !== document.body && active.closest('[role="dialog"], input, textarea')) {
    return;
  }
  const heading = document.querySelector<HTMLElement>('main h1');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

export default function TransitionRouter({ children }: { children: ReactNode }) {
  const [history] = useState(() => createBrowserHistory({ v5Compat: true }));
  const [state, setState] = useState<RouterState>(() => ({
    action: history.action,
    location: history.location,
  }));
  // The newest location, ahead of React state: a second navigation before the
  // first transition's commit must diff against (and commit) the latest one.
  const latest = useRef(state);

  // The browser's own restoration fights ours (and jumps on overlay pops).
  useLayoutEffect(() => {
    if (!('scrollRestoration' in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useLayoutEffect(
    () =>
      history.listen(({ action, location, delta }) => {
        const from = latest.current.location.pathname;
        // Still showing the old page: remember where it was scrolled to.
        if (from !== location.pathname) saveScroll(latest.current.location.key);
        latest.current = { action, location };
        const kind = routeTransitionKind(from, location.pathname, action, delta);
        const started =
          kind !== null &&
          startRouteTransition(kind, () => {
            // Snapshot of the old page is taken; commit the new one now.
            flushSync(() => setState(latest.current));
          });
        if (!started) startTransition(() => setState(latest.current));
      }),
    [history],
  );

  // Runs during the commit (flushSync inside the transition's update callback).
  const committed = useRef(state.location);
  useLayoutEffect(() => {
    const previous = committed.current;
    committed.current = state.location;
    if (previous.pathname === state.location.pathname) return;
    const top = state.action === 'POP' ? (savedScroll.get(state.location.key) ?? 0) : 0;
    window.scrollTo({ top, left: 0, behavior: 'instant' });
    focusPageHeading();
  }, [state]);

  return (
    <Router location={state.location} navigationType={state.action} navigator={history}>
      {children}
    </Router>
  );
}
