/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

export type Theme = 'light' | 'dark' | 'amoled' | 'system';
export type DarkVariant = 'dark' | 'amoled';

const STORAGE_KEY = 'splitup-theme';
const VARIANT_KEY = 'splitup-dark-variant';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface ThemeContextValue {
  theme: Theme;
  resolved: 'light' | 'dark' | 'amoled';
  /** Which dark the quick toggle (and system-dark) resolves to; set by picking Dark or AMOLED in Account. */
  darkVariant: DarkVariant;
  setTheme: (theme: Theme) => void;
  /** Quick light ↔ dark flip, using the remembered dark variant. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function storedTheme(): Theme {
  const value = localStorage.getItem(STORAGE_KEY);
  // Dark is opt-in: the app starts light until the user explicitly chooses
  // Dark, AMOLED, or System in Account → Appearance (or taps the quick toggle).
  return value === 'light' || value === 'dark' || value === 'amoled' || value === 'system'
    ? value
    : 'light';
}

function storedVariant(): DarkVariant {
  const value = localStorage.getItem(VARIANT_KEY);
  if (value === 'dark' || value === 'amoled') return value;
  // Migrate: an existing AMOLED choice predates the variant key.
  return storedTheme() === 'amoled' ? 'amoled' : 'dark';
}

function resolveTheme(
  theme: Theme,
  variant: DarkVariant,
  system: 'light' | 'dark' = systemTheme(),
): 'light' | 'dark' | 'amoled' {
  if (theme === 'system') return system === 'dark' ? variant : 'light';
  return theme;
}

// Must match --background per theme in index.css and public/theme-init.js.
const META_THEME_COLORS: Record<'light' | 'dark' | 'amoled', string> = {
  light: '#f3f0ee',
  dark: '#161514',
  amoled: '#000000',
};

function applyClasses(resolved: 'light' | 'dark' | 'amoled') {
  const root = document.documentElement;
  // AMOLED keeps .dark so every dark-variant style still applies; the .amoled
  // token block then pushes the surfaces to true black.
  root.classList.toggle('dark', resolved !== 'light');
  root.classList.toggle('amoled', resolved === 'amoled');
  // OS chrome (status bar, Android system bars) reads the theme-color metas;
  // overwrite both media-keyed ones so it follows the app theme, not the OS.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', META_THEME_COLORS[resolved]);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [darkVariant, setVariantState] = useState<DarkVariant>(storedVariant);
  // OS appearance as React state: an OS light/dark flip re-renders consumers
  // (toggle icon, Account picker), not just the <html> classes.
  const system = useSyncExternalStore(subscribeSystemTheme, systemTheme);
  const resolved = resolveTheme(theme, darkVariant, system);
  // The sweep in flight, so a tap mid-animation can cut it short.
  const transition = useRef<ViewTransition | null>(null);
  // The theme the latest tap asked for — ahead of `resolved` while a sweep's
  // update callback is still pending, so back-to-back taps alternate correctly.
  const target = useRef<'light' | 'dark' | 'amoled' | null>(null);

  useEffect(() => {
    applyClasses(resolved);
  }, [resolved]);

  const commit = useCallback(
    (nextTheme: Theme, nextVariant: DarkVariant) => {
      localStorage.setItem(STORAGE_KEY, nextTheme);
      localStorage.setItem(VARIANT_KEY, nextVariant);
      target.current = resolveTheme(nextTheme, nextVariant);
      const apply = () => {
        // flushSync so the new theme classes are on <html> before the view
        // transition snapshots the "new" state.
        flushSync(() => {
          setThemeState(nextTheme);
          setVariantState(nextVariant);
        });
        applyClasses(resolveTheme(nextTheme, nextVariant));
      };
      // Mid-sweep, `resolved` may lag the tap, so only skip the animation for
      // a no-op change when nothing is in flight.
      const unchanged = !transition.current && resolveTheme(nextTheme, nextVariant) === resolved;
      if (
        unchanged ||
        !document.startViewTransition ||
        window.matchMedia(REDUCED_MOTION_QUERY).matches
      ) {
        apply();
        target.current = null;
        return;
      }
      // A rapid second tap: finish the running sweep instantly, then sweep
      // from there to the new theme — no waiting for the first to settle.
      transition.current?.skipTransition();
      const current = document.startViewTransition(apply);
      transition.current = current;
      void current.finished.finally(() => {
        if (transition.current === current) {
          transition.current = null;
          target.current = null;
        }
      });
    },
    [resolved],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      commit(next, next === 'dark' || next === 'amoled' ? next : darkVariant);
    },
    [commit, darkVariant],
  );

  const toggleTheme = useCallback(() => {
    const showing = target.current ?? resolved;
    commit(showing === 'light' ? darkVariant : 'light', darkVariant);
  }, [commit, resolved, darkVariant]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, darkVariant, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
