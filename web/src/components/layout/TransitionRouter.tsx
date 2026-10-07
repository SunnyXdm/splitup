import { startTransition, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Router, UNSAFE_createBrowserHistory as createBrowserHistory } from 'react-router';
import { routeTransitionKind, startRouteTransition } from '@/lib/view-transitions';

type RouterState = Pick<ReturnType<typeof createBrowserHistory>, 'action' | 'location'>;

/**
 * BrowserRouter, plus page view transitions. Same history and Router as
 * BrowserRouter; the difference is how a location change is committed: when
 * the path changes, the commit runs inside document.startViewTransition so the
 * old page can slide/fade out under the new one. Direction comes from the
 * history action (Back/Forward POPs carry a delta). Same-path changes — search
 * params, and the same-URL entries overlays push for Back-to-close — commit
 * without a transition, exactly like BrowserRouter.
 */
export default function TransitionRouter({ children }: { children: ReactNode }) {
  const [history] = useState(() => createBrowserHistory({ v5Compat: true }));
  const [state, setState] = useState<RouterState>(() => ({
    action: history.action,
    location: history.location,
  }));
  // The newest location, ahead of React state: a second navigation before the
  // first transition's commit must diff against (and commit) the latest one.
  const latest = useRef(state);

  useLayoutEffect(
    () =>
      history.listen(({ action, location, delta }) => {
        const from = latest.current.location.pathname;
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

  return (
    <Router location={state.location} navigationType={state.action} navigator={history}>
      {children}
    </Router>
  );
}
