import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

/** Bottom-nav tab roots: their pages get a title but no back chevron. */
export const TAB_ROOT_PATHS = ['/', '/friends', '/activity', '/account'] as const;

export function isTabRoot(pathname: string): boolean {
  return (TAB_ROOT_PATHS as readonly string[]).includes(pathname);
}

/** Single-purpose landing pages (invites, claims) render without tab bar or FAB. */
export function isChromelessPath(pathname: string): boolean {
  return /^\/(join|friend|claim)\/[^/]+\/?$/.test(pathname);
}

/**
 * Where Back goes when there's no in-app page to return to (a deep link, a
 * push notification, a fresh PWA launch): the screen's parent tab.
 */
export function parentPath(pathname: string): string {
  if (pathname.startsWith('/friends/')) return '/friends';
  if (pathname.startsWith('/activity/')) return '/activity';
  if (pathname.startsWith('/account/')) return '/account';
  return '/';
}

/**
 * True when the previous history entry is a page of this app: react-router
 * numbers its entries (`idx`), so idx > 0 means navigate(-1) stays in-app.
 */
export function hasInAppHistory(state: unknown = window.history.state): boolean {
  if (typeof state !== 'object' || state === null || !('idx' in state)) return false;
  const idx = (state as { idx: unknown }).idx;
  return typeof idx === 'number' && idx > 0;
}

/**
 * Back for a pushed page: history back when there's an in-app entry (so the
 * previous screen keeps its scroll and state), otherwise REPLACE with the
 * parent route (so Back from there doesn't bounce into this page again).
 */
export function useBack(fallback?: string): () => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback(() => {
    if (hasInAppHistory()) navigate(-1);
    else navigate(fallback ?? parentPath(pathname), { replace: true });
  }, [navigate, fallback, pathname]);
}

const APP_TITLE = 'Splitup';

/** Sets document.title ("<title> · Splitup") while the calling page is mounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · ${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}
