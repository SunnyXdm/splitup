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
  // The sweep in flight. A tap mid-sweep reverses it rather than starting a
  // new one, so rapid taps rewind smoothly instead of snapping.
  const sweep = useRef<{
    transition: ViewTransition;
    /** What the page shows once the sweep settles in its current direction. */
    settlesOn: 'light' | 'dark' | 'amoled';
    /** Theme/variant to restore if the sweep ends rewound. */
    previous: { theme: Theme; variant: DarkVariant; resolved: 'light' | 'dark' | 'amoled' };
    next: { resolved: 'light' | 'dark' | 'amoled' };
  } | null>(null);

  useEffect(() => {
    applyClasses(resolved);
  }, [resolved]);

  const commit = useCallback(
    (nextTheme: Theme, nextVariant: DarkVariant) => {
      localStorage.setItem(STORAGE_KEY, nextTheme);
      localStorage.setItem(VARIANT_KEY, nextVariant);
      const nextResolved = resolveTheme(nextTheme, nextVariant);
      const apply = () => {
        // flushSync so the new theme classes are on <html> before the view
        // transition snapshots the "new" state.
        flushSync(() => {
          setThemeState(nextTheme);
          setVariantState(nextVariant);
        });
        applyClasses(nextResolved);
      };

      const running = sweep.current;
      if (running) {
        // Mid-sweep: rewind (or re-advance) the sweep in place when the tap
        // asks for the side it came from (or is heading to).
        const sweepAnims = document
          .getAnimations()
          .filter((a) =>
            (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition'),
          );
        const towardPrevious = nextResolved === running.previous.resolved;
        const towardNext = nextResolved === running.next.resolved;
        if (sweepAnims.length > 0 && (towardPrevious || towardNext)) {
          if (running.settlesOn !== nextResolved) {
            for (const a of sweepAnims) a.reverse();
            running.settlesOn = nextResolved;
          }
          return;
        }
        running.transition.skipTransition();
      }

      if (
        nextResolved === resolved ||
        !document.startViewTransition ||
        window.matchMedia(REDUCED_MOTION_QUERY).matches
      ) {
        apply();
        return;
      }

      const transition = document.startViewTransition(apply);
      const state = {
        transition,
        settlesOn: nextResolved,
        previous: { theme, variant: darkVariant, resolved },
        next: { resolved: nextResolved },
      };
      sweep.current = state;
      void transition.ready
        .then(() => {
          // The expanding circle drives the end of the sweep. If it ends
          // rewound, swap the DOM back while the overlay still shows the old
          // snapshot, so removing the overlay reveals no flash.
          const expand = document
            .getAnimations()
            .find(
              (a) =>
                (a.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-new(root)',
            );
          expand?.addEventListener('finish', () => {
            if (state.settlesOn !== state.next.resolved) {
              const { theme: t, variant: v } = state.previous;
              localStorage.setItem(STORAGE_KEY, t);
              localStorage.setItem(VARIANT_KEY, v);
              flushSync(() => {
                setThemeState(t);
                setVariantState(v);
              });
              applyClasses(state.previous.resolved);
            }
          });
        })
        .catch(() => {});
      void transition.finished.finally(() => {
        if (sweep.current === state) sweep.current = null;
      });
    },
    [resolved, theme, darkVariant],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      commit(next, next === 'dark' || next === 'amoled' ? next : darkVariant);
    },
    [commit, darkVariant],
  );

  const toggleTheme = useCallback(() => {
    // Mid-sweep, flip relative to where the sweep is heading, not the DOM.
    const showing = sweep.current?.settlesOn ?? resolved;
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
