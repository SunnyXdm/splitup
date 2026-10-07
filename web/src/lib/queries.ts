import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { del } from 'idb-keyval';
import { api } from './api';
import { broadcastSignOut, clearSignedOut, markSignedOut } from './auth-session';
import { netCash } from './settlement-batches';
import { clearAllDrafts, clearOtherUsersDrafts } from './draft-store';
import {
  tempExpenseId,
  withBatch,
  withCreatedExpense,
  withResolvedBatch,
  withRestoredBatch,
  withoutBatch,
  withoutBatchOnly,
  withResolvedTemp,
  withRestoredExpense,
  withRestoredUpdate,
  withServerExpense,
  withUpdatedExpense,
  withoutExpense,
  withoutExpenses,
} from './optimistic';
import { clearPendingInvite } from './pending-invite';
import { unsubscribeOnSignOut } from './push';
import type {
  DeletedExpenses,
  Expense,
  ExpenseInput,
  ExpenseRevisions,
  FriendInvitePreview,
  Group,
  InvitePreview,
  Me,
  SettlementBatch,
  SettlementMethod,
  SyncData,
  User,
} from './types';

export const SYNC_KEY = ['sync'] as const;

/** IndexedDB key of the persisted query cache. */
export const PERSIST_KEY = 'splitup-cache';

/**
 * Shared key of every optimistic expense write (create / update / delete /
 * settle), so they can coordinate: only the LAST one to settle refetches.
 */
export const EXPENSE_WRITE_KEY = ['expense-write'] as const;

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

/**
 * Drops the cached dataset in memory AND on disk (a throttled persister write
 * alone can be lost to a navigation). Used when the data belongs to someone
 * else than the signed-in user.
 */
export async function discardCachedData(qc: QueryClient): Promise<void> {
  await del(PERSIST_KEY);
  await qc.resetQueries({ queryKey: SYNC_KEY });
}

export function useExchangeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (idToken: string) =>
      api<{ me: Me }>('/api/auth/session', {
        method: 'POST',
        body: { idToken },
      }),
    onSuccess: async ({ me }) => {
      // A different account than the cached dataset's owner: never let the
      // previous user's data render (or persist) under the new session.
      const cached = qc.getQueryData<SyncData>(SYNC_KEY);
      if (cached && cached.me.id !== me.id) {
        await discardCachedData(qc);
        // Drafts are per account; another account's never stay on this device.
        await clearOtherUsersDrafts(me.id);
      }
      await qc.invalidateQueries();
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    // Mark the explicit sign-out BEFORE the request: from here on, a 401 must
    // not trigger the automatic token re-exchange that would sign us back in.
    onMutate: () => markSignedOut(),
    mutationFn: async () => {
      // While the session still exists: stop this device getting the account's
      // push notifications (best effort, time-bounded — never blocks sign-out).
      await unsubscribeOnSignOut();
      await api<void>('/api/auth/session', { method: 'DELETE' });
    },
    // Wipe everything on sign-out — and delete the IndexedDB copy DIRECTLY.
    // qc.clear() alone only schedules a throttled persister write that the
    // post-sign-out navigation kills, leaving the user's data on disk for the
    // next person on this browser. mutateAsync awaits this callback.
    onSuccess: async () => {
      qc.clear();
      clearPendingInvite();
      await del(PERSIST_KEY);
      // Unsent drafts are account data too: they go with the account.
      await clearAllDrafts();
      broadcastSignOut();
    },
    onError: () => clearSignedOut(),
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
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      name?: string;
      emoji?: string;
      currency?: string;
    }) => api<Group>(`/api/groups/${id}`, { method: 'PATCH', body }),
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
      api<{ token: string; url: string }>(`/api/groups/${groupId}/invites`, {
        method: 'POST',
      }),
  });
}

export function useRemoveGroupMember() {
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: number }) =>
      api<void>(`/api/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
      }),
    ...useSyncInvalidation(),
  });
}

export function useAddGroupMember() {
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: number; userId: number }) =>
      api<Group>(`/api/groups/${groupId}/members`, {
        method: 'POST',
        body: { userId },
      }),
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

export type AddFriendResult = { status: 'requested' } | { status: 'friends'; user: User };

/**
 * Sends a friend request by email. The server answers 'requested' for unknown
 * emails too (no account-existence oracle), or 'friends' when they had
 * already asked me / we already are.
 */
export function useAddFriend() {
  return useMutation({
    mutationFn: (email: string) =>
      api<AddFriendResult>('/api/friends', { method: 'POST', body: { email } }),
    ...useSyncInvalidation(),
  });
}

export function useAcceptFriendRequest() {
  return useMutation({
    mutationFn: (requestId: number) =>
      api<{ status: 'friends'; user: User }>(`/api/friends/requests/${requestId}/accept`, {
        method: 'POST',
      }),
    ...useSyncInvalidation(),
  });
}

/** Declines an incoming request or cancels an outgoing one. */
export function useDeleteFriendRequest() {
  return useMutation({
    mutationFn: (requestId: number) =>
      api<void>(`/api/friends/requests/${requestId}`, { method: 'DELETE' }),
    ...useSyncInvalidation(),
  });
}

export function useCreateFriendInvite() {
  return useMutation({
    mutationFn: () =>
      api<{ token: string; url: string }>('/api/friends/invites', {
        method: 'POST',
      }),
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
      api<{ user: User }>(`/api/friends/invites/${token}/accept`, {
        method: 'POST',
      }),
    ...useSyncInvalidation(),
  });
}

/** Applies a transform to the cached dataset, if any. */
function patchSync(qc: QueryClient, fn: (sync: SyncData) => SyncData): void {
  qc.setQueryData<SyncData>(SYNC_KEY, (old) => (old ? fn(old) : old));
}

/**
 * Refetch once the LAST concurrent expense write settles. An earlier write
 * refetching mid-burst would pull a snapshot without the later writes and
 * flicker their optimistic rows away. onSettled runs while this mutation still
 * counts as pending, hence `=== 1`.
 */
function invalidateIfLastWrite(qc: QueryClient) {
  if (qc.isMutating({ mutationKey: EXPENSE_WRITE_KEY }) === 1) {
    return qc.invalidateQueries({ queryKey: SYNC_KEY });
  }
}

/** True while any optimistic expense write is in flight. */
export function useExpenseWritePending(): boolean {
  return useIsMutating({ mutationKey: EXPENSE_WRITE_KEY }) > 0;
}

export type CreateExpenseVars = ExpenseInput & {
  /** Idempotency key so a retried POST can't record the expense twice. */
  clientKey?: string;
};

/**
 * The daily-use mutations are optimistic: the cached dataset updates
 * immediately (balances, lists, hero all derive from it), the request runs in
 * the background, and an error undoes ONLY that mutation's own change (never
 * a whole-snapshot restore, which would also wipe concurrent writes and any
 * fresher server data). Successes swap temp rows for server rows; the last
 * write to settle re-syncs.
 */
export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: (body: CreateExpenseVars) =>
      api<Expense>('/api/expenses', { method: 'POST', body }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const tempId = tempExpenseId();
      patchSync(qc, (sync) => withCreatedExpense(sync, body, sync.me.id, tempId));
      return { tempId };
    },
    onSuccess: (expense, _body, ctx) => {
      patchSync(qc, (sync) => withResolvedTemp(sync, ctx.tempId, expense));
    },
    onError: (_err, _body, ctx) => {
      if (ctx) patchSync(qc, (sync) => withoutExpenses(sync, [ctx.tempId]));
    },
    onSettled: () => invalidateIfLastWrite(qc),
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
  /** Idempotency key so a retried POST can't record the payments twice. */
  clientKey?: string;
  rows: {
    groupId: number | null;
    payerId: number;
    recipientId: number;
    amountCents: number;
  }[];
  /** Optional receipt details, stored on the settle-up batch. */
  method?: SettlementMethod | null;
  reference?: string;
  note?: string;
}

/**
 * Records every payment row of one settle atomically (friend-balance settles
 * and in-group settles alike). Rows are applied optimistically as individual
 * payment expenses; a failure (including the 409 freshness rejection) removes
 * exactly those rows.
 */
export function useSettleUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: (body: SettlementInput) =>
      api<{ expenses: Expense[]; batch?: SettlementBatch | null }>('/api/settlements', {
        method: 'POST',
        body,
      }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const tempIds = body.rows.map(() => tempExpenseId());
      const tempBatchId = tempExpenseId();
      patchSync(qc, (sync) => {
        let next = sync;
        body.rows.forEach((row, i) => {
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
                {
                  userId: row.payerId,
                  paidCents: row.amountCents,
                  owedCents: 0,
                },
                {
                  userId: row.recipientId,
                  paidCents: 0,
                  owedCents: row.amountCents,
                },
              ],
            },
            sync.me.id,
            tempIds[i],
          );
        });
        // A temp batch so the settle already reads as one receipt.
        const temp = new Set(tempIds);
        next = {
          ...next,
          expenses: next.expenses.map((e) =>
            temp.has(e.id) ? { ...e, settlementBatchId: tempBatchId } : e,
          ),
        };
        const cash = netCash(body.rows, sync.me.id, body.counterpartyId);
        return withBatch(next, {
          id: tempBatchId,
          ...cash,
          currency: body.currency,
          date: body.date,
          method: body.method ?? null,
          reference: body.reference?.trim() || null,
          note: body.note?.trim() || null,
          createdBy: sync.me.id,
          createdAt: new Date().toISOString(),
          rows: tempIds,
        });
      });
      return { tempIds, tempBatchId };
    },
    onSuccess: ({ expenses, batch }, _body, ctx) => {
      patchSync(qc, (sync) => {
        // The server returns one expense per row, in row order.
        let next = sync;
        ctx.tempIds.forEach((tempId, i) => {
          next = expenses[i] ? withResolvedTemp(next, tempId, expenses[i]) : next;
        });
        return batch
          ? withResolvedBatch(next, ctx.tempBatchId, batch)
          : withoutBatchOnly(next, ctx.tempBatchId);
      });
    },
    onError: (_err, _body, ctx) => {
      if (ctx) {
        patchSync(qc, (sync) =>
          withoutBatchOnly(withoutExpenses(sync, ctx.tempIds), ctx.tempBatchId),
        );
      }
    },
    onSettled: () => invalidateIfLastWrite(qc),
  });
}

/**
 * Undo a whole settle-up: the batch and all of its rows vanish optimistically;
 * a failure puts back exactly what this mutation removed.
 */
export function useUndoSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: (batchId: number) => api<void>(`/api/settlements/${batchId}`, { method: 'DELETE' }),
    onMutate: async (batchId) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const sync = qc.getQueryData<SyncData>(SYNC_KEY);
      const batch = sync?.settlementBatches?.find((b) => b.id === batchId);
      const rows = sync?.expenses.filter((e) => e.settlementBatchId === batchId) ?? [];
      patchSync(qc, (s) => withoutBatch(s, batchId));
      return { batch, rows };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.batch) {
        const { batch, rows } = ctx;
        patchSync(qc, (sync) => withRestoredBatch(sync, batch, rows));
      }
    },
    onSettled: () => invalidateIfLastWrite(qc),
  });
}

export type UpdateExpenseVars = ExpenseInput & {
  id: number;
  /** The updatedAt the edit started from; the server 409s if it changed. */
  expectedUpdatedAt: string;
};

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: ({ id, ...body }: UpdateExpenseVars) =>
      api<Expense>(`/api/expenses/${id}`, { method: 'PATCH', body }),
    onMutate: async ({ id, ...body }) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY)?.expenses.find((e) => e.id === id);
      patchSync(qc, (sync) => withUpdatedExpense(sync, id, body));
      const optimistic = qc.getQueryData<SyncData>(SYNC_KEY)?.expenses.find((e) => e.id === id);
      return { prev, optimistic };
    },
    onSuccess: (expense) => {
      patchSync(qc, (sync) => withServerExpense(sync, expense));
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && ctx.optimistic) {
        const { prev, optimistic } = ctx;
        patchSync(qc, (sync) => withRestoredUpdate(sync, prev, optimistic));
      }
    },
    onSettled: () => invalidateIfLastWrite(qc),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: (id: number) => api<void>(`/api/expenses/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: SYNC_KEY });
      const prev = qc.getQueryData<SyncData>(SYNC_KEY)?.expenses.find((e) => e.id === id);
      patchSync(qc, (sync) => withoutExpense(sync, id));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) {
        const { prev } = ctx;
        patchSync(qc, (sync) => withRestoredExpense(sync, prev));
      }
    },
    onSettled: () => invalidateIfLastWrite(qc),
  });
}

/** History lives outside /sync (keeps that payload small); fetched on demand. */
export const REVISIONS_KEY = 'expense-revisions';
export const DELETED_KEY = 'deleted-expenses';

export function useExpenseRevisions(expenseId: number, enabled: boolean) {
  return useQuery({
    queryKey: [REVISIONS_KEY, expenseId],
    queryFn: () => api<ExpenseRevisions>(`/api/expenses/${expenseId}/revisions`),
    enabled,
    staleTime: 0,
  });
}

export type DeletedScope = { groupId: number } | { friendId: number };

export function useDeletedExpenses(scope: DeletedScope, enabled: boolean) {
  const query = 'groupId' in scope ? `groupId=${scope.groupId}` : `friendId=${scope.friendId}`;
  return useQuery({
    queryKey: [DELETED_KEY, query],
    queryFn: () => api<DeletedExpenses>(`/api/expenses/deleted?${query}`),
    enabled,
    staleTime: 0,
  });
}

export interface RestoreExpenseVars {
  id: number;
  revision: number;
  /** The updatedAt the client last saw; a mismatch → 409 conflict. */
  expectedUpdatedAt?: string;
}

/**
 * Restore (undelete / revert) is validated server-side against membership,
 * departed members and settle-ups, so it isn't optimistic: the server row
 * replaces (or re-adds) the cached one, then the dataset and history refetch.
 */
export function useRestoreExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: EXPENSE_WRITE_KEY,
    mutationFn: ({ id, ...body }: RestoreExpenseVars) =>
      api<Expense>(`/api/expenses/${id}/restore`, { method: 'POST', body }),
    onSuccess: (expense) => {
      patchSync(qc, (sync) =>
        sync.expenses.some((e) => e.id === expense.id)
          ? withServerExpense(sync, expense)
          : withRestoredExpense(sync, expense),
      );
    },
    onSettled: (_data, _err, vars) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: SYNC_KEY }),
        qc.invalidateQueries({ queryKey: [REVISIONS_KEY, vars.id] }),
        qc.invalidateQueries({ queryKey: [DELETED_KEY] }),
      ]),
  });
}
