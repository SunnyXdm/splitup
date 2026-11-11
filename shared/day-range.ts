export interface DayRange {
  /** Inclusive YYYY-MM-DD bounds; null = open-ended. */
  from: string | null;
  to: string | null;
}

export function inDayRange(date: string, r: DayRange): boolean {
  if (r.from !== null && !(date >= r.from)) return false;
  if (r.to !== null && !(date <= r.to)) return false;
  return true;
}
