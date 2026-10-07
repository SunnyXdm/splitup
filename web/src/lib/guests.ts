import { groupBalances } from './balances';
import type { SyncData, User } from './types';

/**
 * Guest participants: people without Splitup whose share a group's members
 * track. They're ordinary users in the dataset (balances, routing, explainer
 * and search need nothing special) flagged with isGuest.
 */

export const GUEST_NAME_MAX = 60;

export const isGuest = (user: Pick<User, 'isGuest'> | undefined | null): boolean =>
  user?.isGuest === true;

/** The trimmed, whitespace-collapsed name, or null when empty / too long. */
export function normalizeGuestName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= GUEST_NAME_MAX ? name : null;
}

/** A guest can be removed only when settled in every currency (the server enforces it too). */
export function guestRemovable(sync: SyncData, groupId: number, userId: number): boolean {
  return !groupBalances(sync, groupId).some((b) => b.userId === userId && b.netCents !== 0);
}

/** The message that goes with a claim link. */
export function claimShareText(groupName: string, url: string): string {
  return `Join me on Splitup to see what you owe in ${groupName}: ${url}`;
}
