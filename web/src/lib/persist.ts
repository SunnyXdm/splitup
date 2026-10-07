import type { PersistedClient } from '@tanstack/react-query-persist-client';
import type { Query } from '@tanstack/react-query';
import { withoutTempRows } from './optimistic';
import type { SyncData } from './types';

/**
 * Persist ONLY the offline dataset, and only while it holds data — including
 * when the latest refetch errored (offline, 5xx): the last good snapshot must
 * survive a reload. Transient queries (invite previews) are never persisted:
 * a revived preview can contradict server truth.
 */
export function shouldPersistQuery(query: Query): boolean {
  return query.queryKey[0] === 'sync' && query.state.data !== undefined;
}

/** Optimistic temp rows never hit disk: their mutations die with the page. */
export function serializeSyncData(data: unknown): unknown {
  return data && typeof data === 'object' && 'expenses' in data
    ? withoutTempRows(data as SyncData)
    : data;
}

/**
 * Final pass before writing: a sync query whose last refetch failed is stored
 * as a plain success (its data is the last good snapshot), so a reload doesn't
 * revive a stale error. Mutations are never persisted (paused optimistic
 * writes would replay blindly on a later visit).
 */
export function sanitizePersistedClient(client: PersistedClient): PersistedClient {
  return {
    ...client,
    clientState: {
      mutations: [],
      queries: client.clientState.queries.map((q) =>
        q.state.status === 'error' && q.state.data !== undefined
          ? {
              ...q,
              state: {
                ...q.state,
                status: 'success' as const,
                error: null,
                fetchFailureCount: 0,
                fetchFailureReason: null,
              },
            }
          : q,
      ),
    },
  };
}
