import { format, isValid, parseISO } from 'date-fns';

/** Parses an ISO date/datetime; null instead of an Invalid Date. */
export function parseDateSafe(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const d = parseISO(iso);
  return isValid(d) ? d : null;
}

/**
 * date-fns format() that never throws: a malformed date from the server or an
 * old cached payload renders as `fallback` instead of crashing the screen
 * (format() throws RangeError on Invalid Date).
 */
export function formatDateSafe(
  iso: string | null | undefined,
  pattern: string,
  fallback = 'Unknown date',
): string {
  const d = parseDateSafe(iso);
  return d ? format(d, pattern) : fallback;
}
