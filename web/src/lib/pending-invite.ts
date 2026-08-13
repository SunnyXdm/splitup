/**
 * Invite links must survive the Google sign-in round-trip. shoo keeps its
 * post-login `returnTo` in sessionStorage, which is tab-scoped and is routinely
 * lost when the link is opened from an in-app browser (chat apps) and OAuth
 * bounces through Google. We stash the pending invite in localStorage instead —
 * origin-scoped, so it survives the whole flow — and redirect to it after auth.
 */
const KEY = 'splitup-pending-invite';

export type InviteKind = 'friend' | 'join';

export interface PendingInvite {
  kind: InviteKind;
  token: string;
  capturedAt: number;
}

const INVITE_PATH = /^\/(friend|join)\/([0-9a-f]{16,64})$/;

/**
 * Markers are short-lived: long enough to survive the OAuth round-trip, short
 * enough that an abandoned pre-sign-in visit can't hijack a later sign-in
 * (possibly by a different person on a shared browser).
 */
const MAX_AGE_MS = 60 * 60 * 1000;

/** Call before the app mounts: remember an invite URL the visitor arrived on. */
export function capturePendingInviteFromUrl(): void {
  const match = window.location.pathname.match(INVITE_PATH);
  if (!match) return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ kind: match[1], token: match[2], capturedAt: Date.now() }),
    );
  } catch {
    // storage blocked (private mode) — the direct link still works when returnTo survives
  }
}

export function readPendingInvite(): PendingInvite | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingInvite;
    if (
      (value.kind === 'friend' || value.kind === 'join') &&
      /^[0-9a-f]{16,64}$/.test(value.token) &&
      typeof value.capturedAt === 'number' &&
      Date.now() - value.capturedAt < MAX_AGE_MS
    ) {
      return value;
    }
    localStorage.removeItem(KEY);
  } catch {
    // ignore malformed / blocked storage
  }
  return null;
}

export function clearPendingInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function pendingInvitePath(invite: PendingInvite): string {
  return `/${invite.kind}/${invite.token}`;
}
