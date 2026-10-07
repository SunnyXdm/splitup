import { createContext, useContext, useEffect, useState, type CSSProperties } from 'react';

/**
 * Small motion helpers. Everything here animates transform/opacity only and
 * stands down under prefers-reduced-motion.
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
}

/** Entrances already played this session, by screen/list key. */
const played = new Set<string>();
/** Long enough for the last staggered item (7 × step + duration) to finish. */
const ENTRANCE_WINDOW_MS = 700;

/**
 * True while a list's first-mount entrance should play: only the first time
 * `key` mounts in this session, and only for a short window — so revisits,
 * re-renders and refetches never replay it, and rows added later don't
 * inherit a stagger meant for the initial paint.
 */
export function useEntrance(key: string): boolean {
  const [active, setActive] = useState(() => !played.has(key) && !prefersReducedMotion());
  useEffect(() => {
    played.add(key);
    if (!active) return;
    const timer = setTimeout(() => setActive(false), ENTRANCE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [key, active]);
  return active;
}

/** Items past this index skip the entrance (they start below the fold). */
const ENTER_LIMIT = 12;

/**
 * Whether the surrounding EntranceScope is still in its entrance window.
 * Read by the items themselves, so the window closing re-renders only the
 * items (cheap wrappers), never the whole list that owns the scope.
 */
export const EntranceContext = createContext(false);

/** className/style for one staggered list item (`index` = position). */
export function useEnterItem(index: number): { className?: string; style?: CSSProperties } {
  const entering = useContext(EntranceContext);
  if (!entering || index >= ENTER_LIMIT) return {};
  // The CSS caps the delay at 7 steps.
  return { className: 'motion-enter', style: { '--enter-index': index } as CSSProperties };
}

/** Error shake on an element (WAAPI, transform only). */
export function shake(el: Element | null | undefined): void {
  if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
  el.animate(
    [
      { translate: '0' },
      { translate: '-6px' },
      { translate: '5px' },
      { translate: '-3px' },
      { translate: '2px' },
      { translate: '0' },
    ],
    { duration: 320, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' },
  );
}

/**
 * After a rejected save: shake the fields that just turned invalid, within
 * the sheet/dialog that holds `from` (the button pressed). Waits a frame so
 * the re-render has flagged them.
 */
export function shakeInvalidFields(from: Element | null | undefined): void {
  const scope = from?.closest('[data-slot=sheet-content], [data-slot=dialog-content]');
  if (!scope) return;
  requestAnimationFrame(() => {
    for (const field of scope.querySelectorAll('[data-slot=field][data-invalid=true]')) {
      shake(field);
    }
  });
}
