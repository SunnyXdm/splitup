import type { ReactNode } from 'react';
import { EntranceContext, useEntrance } from '@/lib/motion';

/**
 * Plays a staggered first-mount entrance for the list items inside (those
 * using useEnterItem) — once per `id` per session. Owning the state here keeps
 * the end-of-entrance update from re-rendering the list itself: `children` is
 * created by the parent, so only the context-reading items re-render.
 */
export function EntranceScope({ id, children }: { id: string; children: ReactNode }) {
  const entering = useEntrance(id);
  return <EntranceContext.Provider value={entering}>{children}</EntranceContext.Provider>;
}
