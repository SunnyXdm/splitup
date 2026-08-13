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

  return (
    <button
      type="button"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
      className="flex size-11 items-center justify-center rounded-full bg-card text-foreground shadow-[0_4px_24px_rgba(0,0,0,0.04)] outline-none transition-colors hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Icon className="size-5" aria-hidden="true" />
    </button>
  );
}
