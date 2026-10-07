import { createContext, useContext } from 'react';
import type { DraftScope } from '@/lib/drafts';

/** Opens the app-level drafts list / a draft's review form (hosted by AppShell). */
export interface DraftsUi {
  openDrafts: (scope: DraftScope) => void;
  openDraft: (id: string) => void;
}

export const DraftsUiContext = createContext<DraftsUi | null>(null);

export function useDraftsUi(): DraftsUi {
  const ctx = useContext(DraftsUiContext);
  if (!ctx) throw new Error('useDraftsUi must be used inside <AppShell>');
  return ctx;
}
