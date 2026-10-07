/**
 * View-transition plumbing shared by route changes and the theme sweep.
 *
 * Both use the one document-level View Transition, so their CSS is scoped by
 * a marker on <html> that exists only while that kind of transition runs:
 * - `.theme-sweep` — the circular theme reveal (theme-provider.tsx)
 * - `[data-route-transition="forward" | "back" | "tab"]` — page changes
 * Neither set of `::view-transition-*` rules can leak into the other.
 */

export type RouteTransitionKind = 'forward' | 'back' | 'tab';
export type HistoryAction = 'POP' | 'PUSH' | 'REPLACE';

export const THEME_SWEEP_CLASS = 'theme-sweep';
const ROUTE_ATTR = 'routeTransition'; // → data-route-transition
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Bottom-nav tab roots (mirrors AppShell's TABS). */
const TAB_ROOTS = ['/', '/friends', '/activity', '/account'];

/** The bottom-nav section a path lives under, or null (search, insights…). */
export function tabSection(pathname: string): string | null {
  if (pathname === '/' || pathname.startsWith('/groups')) return '/';
  for (const root of TAB_ROOTS) {
    if (root !== '/' && (pathname === root || pathname.startsWith(`${root}/`))) return root;
  }
  return null;
}

/**
 * How a location change should animate, or null for none. Same-path changes
 * never animate: they are search-param state (tabs, filters) or the same-URL
 * history entries overlays push so Back can close them.
 */
export function routeTransitionKind(
  fromPath: string,
  toPath: string,
  action: HistoryAction,
  delta: number | null,
): RouteTransitionKind | null {
  if (fromPath === toPath) return null;
  // Landing on a tab root from another section is a tab switch: cross-fade.
  if (TAB_ROOTS.includes(toPath) && tabSection(fromPath) !== tabSection(toPath)) return 'tab';
  if (action === 'POP') return delta !== null && delta > 0 ? 'forward' : 'back';
  return 'forward';
}

let activeRoute: ViewTransition | null = null;

function motionAllowed(): boolean {
  return (
    typeof document.startViewTransition === 'function' &&
    document.visibilityState === 'visible' &&
    !window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * Runs `update` (which must commit the new page synchronously) inside a
 * route view transition. Returns false — without calling `update` — when no
 * transition should run, so the caller can commit the normal way.
 */
export function startRouteTransition(kind: RouteTransitionKind, update: () => void): boolean {
  const root = document.documentElement;
  // Never interrupt the theme sweep: its rewind logic owns the transition.
  if (!motionAllowed() || root.classList.contains(THEME_SWEEP_CLASS)) return false;
  root.dataset[ROUTE_ATTR] = kind;
  const transition = document.startViewTransition(update);
  activeRoute = transition;
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (activeRoute !== transition) return;
      activeRoute = null;
      delete root.dataset[ROUTE_ATTR];
    });
  return true;
}

/**
 * Called by the theme sweep before it starts: ends any route transition and
 * drops its marker synchronously, so the sweep never snapshots the page with
 * the route's named (pinned) elements split out of the root.
 */
export function clearRouteTransition(): void {
  const running = activeRoute;
  activeRoute = null;
  delete document.documentElement.dataset[ROUTE_ATTR];
  running?.skipTransition();
}
