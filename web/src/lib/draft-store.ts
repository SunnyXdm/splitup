import { useEffect, useSyncExternalStore } from 'react';
import { del, get, keys, set } from 'idb-keyval';
import {
  DRAFTS_KEY_PREFIX,
  deserializeDrafts,
  draftsKey,
  serializeDrafts,
  withAutosave,
  withDraft,
  withoutDraft,
  type Draft,
  type DraftsState,
} from './drafts';
import type { ExpenseFormValues } from './expense-form';

/**
 * In-memory + IndexedDB store of the signed-in user's drafts. Only ONE user's
 * drafts are ever in memory, and reads for any other user id return nothing.
 * Writes are serialized so a slow write can't land after a newer one.
 */

let state: DraftsState | null = null;
let loading: { userId: number; promise: Promise<void> } | null = null;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function enqueue(task: () => Promise<unknown>) {
  writes = writes.then(task).catch(() => {
    // Storage blocked/full: drafts still work for this session in memory.
  });
  return writes;
}

function commit(userId: number, update: (s: DraftsState) => DraftsState) {
  if (!state || state.userId !== userId) return;
  const next = update(state);
  state = next;
  emit();
  void enqueue(() =>
    next.drafts.length === 0 && Object.keys(next.autosaves).length === 0
      ? del(draftsKey(userId))
      : set(draftsKey(userId), serializeDrafts(next)),
  );
}

export function loadDrafts(userId: number): Promise<void> {
  if (state?.userId === userId) return Promise.resolve();
  if (loading?.userId === userId) return loading.promise;
  // Switching user: drop the previous user's drafts from memory at once.
  state = null;
  emit();
  const promise = (async () => {
    let raw: unknown;
    try {
      raw = await get(draftsKey(userId));
    } catch {
      raw = undefined;
    }
    if (loading?.userId !== userId) return; // superseded
    state = deserializeDrafts(raw, userId);
    loading = null;
    emit();
  })();
  loading = { userId, promise };
  return promise;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The user's drafts, or null while they load. Never another user's. */
export function useDrafts(userId: number | undefined): DraftsState | null {
  useEffect(() => {
    if (userId !== undefined) void loadDrafts(userId);
  }, [userId]);
  const snap = useSyncExternalStore(subscribe, () => state);
  return snap && snap.userId === userId ? snap : null;
}

export function saveAutosave(userId: number, scopeKey: string, values: ExpenseFormValues | null) {
  commit(userId, (s) => withAutosave(s, scopeKey, values));
}

export function saveDraft(userId: number, draft: Draft) {
  commit(userId, (s) => withDraft(s, draft));
}

export function removeDraft(userId: number, id: string) {
  commit(userId, (s) => withoutDraft(s, id));
}

/** Current drafts snapshot outside React (for sequential "Add all"). */
export function currentDrafts(userId: number): Draft[] {
  return state?.userId === userId ? state.drafts : [];
}

async function deleteDraftKeys(keep: (key: string) => boolean) {
  const all = await keys();
  await Promise.all(
    all
      .filter((k): k is string => typeof k === 'string' && k.startsWith(DRAFTS_KEY_PREFIX))
      .filter((k) => !keep(k))
      .map((k) => del(k)),
  );
}

/** Sign-out: every account's drafts leave this device (memory and disk). */
export async function clearAllDrafts(): Promise<void> {
  state = null;
  loading = null;
  emit();
  await enqueue(() => deleteDraftKeys(() => false));
}

/** A different account signed in on this browser: drop everyone else's drafts. */
export async function clearOtherUsersDrafts(userId: number): Promise<void> {
  if (state && state.userId !== userId) {
    state = null;
    emit();
  }
  await enqueue(() => deleteDraftKeys((k) => k === draftsKey(userId)));
}
