import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { ThemeProvider } from '@/components/theme-provider';
import TransitionRouter from '@/components/layout/TransitionRouter';
import { Toaster } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api';
import { capturePendingInviteFromUrl } from '@/lib/pending-invite';
import { sanitizePersistedClient, serializeSyncData, shouldPersistQuery } from '@/lib/persist';
import { setupPwaUpdates } from '@/lib/pwa-update';
import { PERSIST_KEY, SYNC_KEY } from '@/lib/queries';

import './index.css';
import App from './App.tsx';

// Remember an invite link before anything (including shoo's OAuth redirect) runs.
capturePendingInviteFromUrl();
setupPwaUpdates();

const DAY_MS = 24 * 60 * 60 * 1000;

const queryClient: QueryClient = new QueryClient({
  // A 404 on any mutation means the cached entity is gone server-side —
  // refresh the dataset so phantoms disappear instead of staying interactive.
  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: SYNC_KEY });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * DAY_MS,
      retry: 1,
      // Serve persisted data instantly; refetch when the network is back.
      networkMode: 'offlineFirst',
    },
    mutations: {
      networkMode: 'online',
    },
  },
});

const basePersister = createAsyncStoragePersister({
  key: PERSIST_KEY,
  storage: {
    getItem: async (key) => ((await get<string>(key)) ?? null) as string | null,
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
});
const persister = {
  ...basePersister,
  persistClient: (client: Parameters<typeof basePersister.persistClient>[0]) =>
    basePersister.persistClient(sanitizePersistedClient(client)),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 30 * DAY_MS,
          // Tied to the app version: a release that changes the cached shape
          // drops old snapshots instead of rendering them with new code.
          buster: `splitup-${__APP_VERSION__}`,
          // See lib/persist.ts: only the sync dataset (last good snapshot even
          // after a failed refetch), never temp rows or paused mutations.
          dehydrateOptions: {
            shouldDehydrateQuery: shouldPersistQuery,
            shouldDehydrateMutation: () => false,
            serializeData: serializeSyncData,
          },
        }}
      >
        <TransitionRouter>
          <App />
        </TransitionRouter>
        <Toaster position="top-center" />
      </PersistQueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
