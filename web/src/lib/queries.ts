import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del } from 'idb-keyval';
import { api } from './api';
import { withCreatedExpense, withUpdatedExpense, withoutExpense } from './optimistic';
import { clearPendingInvite } from './pending-invite';
import type {
  Expense,
  ExpenseInput,
  FriendInvitePreview,
  Group,
  InvitePreview,
  Me,
  SyncData,
  User,
} from './types';

export const SYNC_KEY = ['sync'] as const;

/** The whole app dataset. Persisted to IndexedDB, so it renders offline. */
export function useSyncData() {
  return useQuery({
    queryKey: SYNC_KEY,
    queryFn: () => api<SyncData>('/api/sync'),
  });
}

function useSyncInvalidation() {
  const qc = useQueryClient();
  return { onSuccess: () => qc.invalidateQueries({ queryKey: SYNC_KEY }) };
}

export function useExchangeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idToken: string) =>
      api<{ me: Me }>('/api/auth/session', { method: 'POST', body: { idToken } }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/api/auth/session', { method: 'DELETE' }),
    // Wipe everything on sign-out — and delete the IndexedDB copy DIRECTLY.
    // qc.clear() alone only schedules a throttled persister write that the
    // post-sign-out navigation kills, leaving the user's data on disk for the
    // next person on this browser. mutateAsync awaits this callback.
    onSuccess: async () => {
      qc.clear();
      clearPendingInvite();
      await del('splitup-cache');
    },
  });
}

export function useUpdateMe() {
  return useMutation({
    mutationFn: (body: { name?: string; defaultCurrency?: string }) =>
      api<Me>('/api/me', { method: 'PATCH', body }),
    ...useSyncInvalidation(),
  });
}

export function useCreateGroup() {
  return useMutation({
    mutationFn: (body: { name: string; emoji?: string; currency?: string }) =>
      api<Group>('/api/groups', { method: 'POST', body }),
    ...useSyncInvalidation(),
  });
}

export function useUpdateGroup() {
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; emoji?: string; currency?: string }) =>
      api<Group>(`/api/groups/${id}`, { method: 'PATCH', body }),
    ...useSyncInvalidation(),
  });
}

export function useDeleteGroup() {
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/groups/${id}`, { method: 'DELETE' }),
    ...useSyncInvalidation(),
  });
}

export function useLeaveGroup() {
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/groups/${id}/leave`, { method: 'POST' }),
    ...useSyncInvalidation(),
  });
}

export function useCreateInvite() {
  return useMutation({
    mutationFn: (groupId: number) =>
      api<{ token: string; url: string }>(`/api/groups/${groupId}/invites`, { method: 'POST' }),
  });
}

export function useRemoveGroupMember() {
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: number }) =>
      api<void>(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),
    ...useSyncInvalidation(),
  });
}

export function useAddGroupMember() {
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: number }) =>
      api<Group>(`/api/groups/${groupId}/members`, { method: 'POST', body: { userId } }),
    ...useSyncInvalidation(),
  });
}

// Preview queries are relationship-state snapshots — always refetch, never
// keep them around (a stale preview can contradict server truth).
const PREVIEW_FRESHNESS = {
  staleTime: 0,
  gcTime: 60_000,
  refetchOnMount: 'always',
  retry: false,
} as const;

export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePreview>(`/api/invites/${token}`),
    ...PREVIEW_FRESHNESS,
  });
}

export function useJoinInvite() {
  return useMutation({
    mutationFn: (token: string) => api<Group>(`/api/invites/${token}/join`, { method: 'POST' }),
    ...useSyncInvalidation(),
  });
}

export function useAddFriend() {
  return useMutation({
    mutationFn: (email: string) =>
      api<{ user: User }>('/api/friends', { method: 'POST', body: { email } }),
    ...useSyncInvalidation(),
  });
}

export function useCreateFriendInvite() {
  return useMutation({
    mutationFn: () =>
      api<{ token: string; url: string }>('/api/friends/invites', { method: 'POST' }),
  });
}

export function useFriendInvitePreview(token: string) {
  return useQuery({
    queryKey: ['friend-invite', token],
    queryFn: () => api<FriendInvitePreview>(`/api/friends/invites/${token}`),
    ...PREVIEW_FRESHNESS,
  });
}

export function useAcceptFriendInvite() {
  return useMutation({
    mutationFn: (token: string) =>
      api<{ user: User }>(`/api/friends/invites/${token}/accept`, { method: 'POST' }),
    ...useSyncInvalidation(),
  });
}

/**
 * The three daily-use mutations are optimistic: the cached dataset updates
 * immediately (balances, lists, hero all derive from it), the request runs in
 * the background, errors roll the cache back, and the settled re-sync replaces
 * temp rows with server truth.
 */
export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExpenseInput) => api<Expense>('/api/expenses', { method: 'POST', body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY);
      if (prev) qc.setQueryData(SYNC_KEY, withCreatedExpense(prev, body, prev.me.id));
      return { prev };
    },
    onError: (_err, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(SYNC_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SYNC_KEY }),
  });
}

export interface SettlementInput {
  counterpartyId: number;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  /** Freshness fingerprint from settlementWatermark(); mismatch → 409. */
  watermark: string;
  watermarkCount: number;
  rows: { groupId: number | null; payerId: number; recipientId: number; amountCents: number }[];
}

/**
 * Records every payment row of one friend-balance settle atomically. Rows are
 * applied optimistically as individual payment expenses; a failure (including
 * the 409 freshness rejection) rolls all of them back together.
 */
export function useSettleUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettlementInput) =>
      api<{ expenses: Expense[] }>('/api/settlements', { method: 'POST', body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY);
      if (prev) {
        let next = prev;
        for (const row of body.rows) {
          next = withCreatedExpense(
            next,
            {
              groupId: row.groupId,
              description: 'Payment',
              amountCents: row.amountCents,
              currency: body.currency,
              date: body.date,
              category: 'general',
              notes: null,
              isPayment: true,
              shares: [
                { userId: row.payerId, paidCents: row.amountCents, owedCents: 0 },
                { userId: row.recipientId, paidCents: 0, owedCents: row.amountCents },
              ],
            },
            prev.me.id,
          );
        }
        qc.setQueryData(SYNC_KEY, next);
      }
      return { prev };
    },
    onError: (_err, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(SYNC_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SYNC_KEY }),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ExpenseInput & { id: number }) =>
      api<Expense>(`/api/expenses/${id}`, { method: 'PATCH', body }),
    onMutate: async ({ id, ...body }) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY);
      if (prev) qc.setQueryData(SYNC_KEY, withUpdatedExpense(prev, id, body));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(SYNC_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SYNC_KEY }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/expenses/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY);
      if (prev) qc.setQueryData(SYNC_KEY, withoutExpense(prev, id));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(SYNC_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SYNC_KEY }),
  });
}
