import { createContext, useContext, useLayoutEffect } from 'react';

export interface AppChrome {
  /** Hides the mobile "+" FAB until the returned release function is called. */
  hideFab: () => () => void;
}

export const AppChromeContext = createContext<AppChrome | null>(null);

/**
 * Hide the global "+" FAB while the calling screen is mounted (and `hidden`
 * is true) — for screens whose own bottom primary action would sit under it.
 * Several callers may hide it at once; it returns when all have released.
 */
export function useHideFab(hidden = true): void {
  const chrome = useContext(AppChromeContext);
  useLayoutEffect(() => {
    if (!hidden || !chrome) return;
    return chrome.hideFab();
  }, [hidden, chrome]);
}
