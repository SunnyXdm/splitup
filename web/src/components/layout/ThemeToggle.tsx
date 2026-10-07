import { useEffect, useRef } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';

/**
 * Quick light/dark flip. Which dark it lands on (Dark or AMOLED) follows the
 * last choice made in Account → Appearance. Positioning is up to the caller.
 */
export default function ThemeToggle() {
  const { resolved, toggleTheme } = useTheme();
  const dark = resolved !== 'light';
  const Icon = dark ? Sun : Moon;
  const button = useRef<HTMLButtonElement>(null);

  // While a theme sweep runs, the browser hit-tests every tap to <html> (the
  // transition overlay hosts the snapshots), so the button never sees a second
  // tap until the sweep ends. Route taps that land on the button's box to it.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.target !== document.documentElement || !button.current) return;
      const r = button.current.getBoundingClientRect();
      if (r.width === 0) return; // hidden copy (mobile vs desktop header)
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        toggleTheme();
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [toggleTheme]);

  return (
    <button
      ref={button}
      type="button"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
      className="flex size-11 items-center justify-center rounded-full bg-card text-foreground shadow-[0_4px_24px_rgba(0,0,0,0.04)] outline-none pressable hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-focus-ring"
    >
      <Icon className="size-5" aria-hidden="true" />
    </button>
  );
}
