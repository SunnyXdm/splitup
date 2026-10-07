import { formatDistanceToNow } from 'date-fns';
import { parseDateSafe } from './dates';
import { useSyncData } from './queries';
import type { User } from './types';

/** "You" for me, else the best name known from the response or the dataset. */
export function useNameOf(extra: User[] | undefined): (id: number) => string {
  const { data: sync } = useSyncData();
  return (id: number) => {
    if (id === sync?.me.id) return 'You';
    return (
      extra?.find((u) => u.id === id)?.name ??
      sync?.users.find((u) => u.id === id)?.name ??
      'Someone'
    );
  };
}

export function relativeTime(iso: string): string {
  const d = parseDateSafe(iso);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '';
}
