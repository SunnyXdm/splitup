import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api';
import { capturePendingInviteFromUrl } from '@/lib/pending-invite';
import { setupPwaUpdates } from '@/lib/pwa-update';
import { SYNC_KEY } from '@/lib/queries';

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

const persister = createAsyncStoragePersister({
  key: 'splitup-cache',
  storage: {
    getItem: async (key) => ((await get<string>(key)) ?? null) as string | null,
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 30 * DAY_MS,
          buster: 'v1',
          // Persist ONLY the offline dataset. Transient queries (invite
          // previews) must never be revived from disk — a cached preview can
          // contradict server truth (expired invite, changed relationship).
          dehydrateOptions: {
            shouldDehydrateQuery: (query) =>
              query.queryKey[0] === 'sync' && query.state.status === 'success',
          },
        }}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster position="top-center" />
      </PersistQueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
