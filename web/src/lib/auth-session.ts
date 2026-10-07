/**
 * Explicit sign-out state shared across tabs.
 *
 * - A localStorage flag records that the user signed out ON PURPOSE, which
 *   suppresses AuthGate's automatic shoo-token → session re-exchange (otherwise
 *   the post-sign-out 401 would silently sign them straight back in). Only an
 *   explicit sign-in clears it.
 * - A BroadcastChannel tells every other open tab to drop its cached data and
 *   identity immediately.
 */

const FLAG_KEY = 'splitup-signed-out';
const CHANNEL = 'splitup-auth';

type SignOutMessage = { type: 'signed-out' };

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function isSignedOut(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function markSignedOut(): void {
  try {
    localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // storage blocked — the broadcast + identity clear still apply
  }
  emit();
}

export function clearSignedOut(): void {
  try {
    localStorage.removeItem(FLAG_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** useSyncExternalStore subscription (also follows other tabs via 'storage'). */
export function subscribeSignedOut(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === FLAG_KEY || e.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function broadcastSignOut(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: 'signed-out' } satisfies SignOutMessage);
    channel.close();
  } catch {
    // unsupported / closed — other tabs fall back to their next 401
  }
}

/** Runs `onSignOut` when ANOTHER tab signs out. Returns an unsubscribe. */
export function onSignOutBroadcast(onSignOut: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent<SignOutMessage>) => {
    if (e.data?.type === 'signed-out') onSignOut();
  };
  return () => channel.close();
}
