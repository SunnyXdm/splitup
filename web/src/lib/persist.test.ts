import { describe, expect, it } from 'vitest';
import { QueryClient, dehydrate } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { sanitizePersistedClient, serializeSyncData, shouldPersistQuery } from './persist';
import type { SyncData } from './types';

const sync = {
  me: { id: 1, name: 'Me', email: null, picture: null, defaultCurrency: 'USD' },
  users: [],
  friendIds: [],
  groups: [],
  expenses: [
    { id: 5, groupId: null } as never,
    { id: -123, groupId: null } as never,
  ],
  activity: [],
  syncedAt: '',
} as SyncData;

describe('persistence filters', () => {
  it('strips optimistic temp rows', () => {
    const out = serializeSyncData(sync) as SyncData;
    expect(out.expenses.map((e) => e.id)).toEqual([5]);
  });

  it('keeps the last good snapshot when a refetch errored', () => {
    const qc = new QueryClient();
    qc.setQueryData(['sync'], sync);
    const query = qc.getQueryCache().find({ queryKey: ['sync'] })!;
    query.setState({ status: 'error', error: new Error('offline'), fetchFailureCount: 1 });
    qc.setQueryData(['invite', 'x'], { token: 'x' });
    const state = dehydrate(qc, {
      shouldDehydrateQuery: shouldPersistQuery,
      shouldDehydrateMutation: () => false,
      serializeData: serializeSyncData,
    });
    expect(state.queries.map((q) => q.queryKey)).toEqual([['sync']]);
    const client: PersistedClient = { timestamp: 0, buster: '', clientState: state };
    const clean = sanitizePersistedClient(client);
    const persisted = clean.clientState.queries[0];
    expect(persisted.state.status).toBe('success');
    expect(persisted.state.error).toBeNull();
    expect((persisted.state.data as SyncData).expenses.map((e) => e.id)).toEqual([5]);
  });
});
