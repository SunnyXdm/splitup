import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DEFAULT_FILTERS, filtersFromParams, filtersToParams, type HistoryFilters } from './search';
import { useOverlayNavigate } from './use-history-dismiss';

const DEBOUNCE_MS = 250;

/**
 * History filters live in the URL (?q=…&range=…), so they survive reloads and
 * Back restores them. Discrete changes (a chip, "Clear") push an entry — Back
 * undoes them — while typing REPLACES, debounced, so a search doesn't leave a
 * history entry per keystroke. Picks made inside a bottom sheet replace the
 * sheet's own history entry (useOverlayNavigate), so it nets out to one push.
 */
export function useHistoryFilters() {
  const [params] = useSearchParams();
  const navigate = useOverlayNavigate();
  const filters = useMemo(() => filtersFromParams(params), [params]);

  const write = useCallback(
    (next: HistoryFilters, replace: boolean) => {
      const search = filtersToParams(next, params).toString();
      navigate({ search: search ? `?${search}` : '' }, { replace });
    },
    [navigate, params],
  );

  // The input's live text; the URL's `q` trails it by DEBOUNCE_MS. When the
  // URL changes underneath us (Back, Clear), adopt its value — adjusting state
  // during render, React's sanctioned alternative to a syncing effect.
  const [text, setText] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  if (filters.q !== seenQ) {
    setSeenQ(filters.q);
    setText(filters.q);
  }

  useEffect(() => {
    const q = text.trim() === '' ? '' : text;
    if (q === filters.q) return;
    const timer = setTimeout(() => write({ ...filters, q }, true), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, filters, write]);

  const update = useCallback(
    // Commits any not-yet-debounced text along with the change.
    (patch: Partial<HistoryFilters>) =>
      write({ ...filters, q: text.trim() === '' ? '' : text, ...patch }, false),
    [filters, text, write],
  );

  const clear = useCallback(() => {
    setText('');
    write(DEFAULT_FILTERS, false);
  }, [write]);

  return { filters, text, setText, update, clear };
}

/** A single URL param (e.g. the GroupDetail tab), replaced in place. */
export function useParamState<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [params] = useSearchParams();
  const navigate = useOverlayNavigate();
  const raw = params.get(key) as T | null;
  const value = raw !== null && allowed.includes(raw) ? raw : fallback;
  const set = useCallback(
    (next: T) => {
      const out = new URLSearchParams(params);
      if (next === fallback) out.delete(key);
      else out.set(key, next);
      const search = out.toString();
      navigate({ search: search ? `?${search}` : '' }, { replace: true });
    },
    [fallback, key, navigate, params],
  );
  return [value, set];
}
