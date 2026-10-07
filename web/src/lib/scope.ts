import type { ScopeChoice } from './expense-form';
import { properName } from './names';
import type { Group, SyncData, User } from './types';

/**
 * Where a new expense goes: one of my groups, or directly with one friend.
 * Pure data for the ScopePicker sheet (search + ordering), no React.
 */
export interface ScopeOption {
  choice: ScopeChoice;
  /** Stable key ("group:4", "friend:7"). */
  key: string;
  /** "Flat 4B" / "Darshna Gupta" */
  name: string;
  /** "4 people · INR" / "Just the two of you" */
  detail: string;
  group?: Group;
  user?: User;
}

export interface ScopeOptions {
  /** My groups, most recent activity first (archived ones only when searched for). */
  groups: ScopeOption[];
  /** Friends for a direct expense, most recent direct expense first, then by name. */
  friends: ScopeOption[];
}

export const scopeKey = (choice: ScopeChoice): string =>
  choice.kind === 'group' ? `group:${choice.groupId}` : `friend:${choice.friendId}`;

const latest = (a: string | undefined, b: string) => (a === undefined || b > a ? b : a);

/** Case- and accent-insensitive "contains". */
function matches(haystack: string, query: string): boolean {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  return fold(haystack).includes(fold(query));
}

export function scopeOptions(sync: SyncData, query = ''): ScopeOptions {
  const meId = sync.me.id;
  const q = query.trim();
  // Latest activity per group and per direct friend, from the expenses I can see.
  const groupActivity = new Map<number, string>();
  const friendActivity = new Map<number, string>();
  for (const e of sync.expenses) {
    const at = e.updatedAt > e.createdAt ? e.updatedAt : e.createdAt;
    if (e.groupId !== null) {
      groupActivity.set(e.groupId, latest(groupActivity.get(e.groupId), at));
    } else {
      for (const s of e.shares) {
        if (s.userId === meId) continue;
        friendActivity.set(s.userId, latest(friendActivity.get(s.userId), at));
      }
    }
  }
  const byName = (a: ScopeOption, b: ScopeOption) => a.name.localeCompare(b.name);

  const groups = sync.groups
    .filter((g) => (q ? matches(g.name, q) : !g.archivedAt))
    .map((g) => ({
      option: {
        choice: { kind: 'group', groupId: g.id },
        key: `group:${g.id}`,
        name: g.name,
        detail: `${g.memberIds.length} ${g.memberIds.length === 1 ? 'person' : 'people'} · ${g.currency}${g.archivedAt ? ' · Archived' : ''}`,
        group: g,
      } satisfies ScopeOption,
      at: groupActivity.get(g.id) ?? g.createdAt,
      archived: Boolean(g.archivedAt),
    }))
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
        byName(a.option, b.option),
    )
    .map((x) => x.option);

  const friends = sync.friendIds
    .map((id) => sync.users.find((u) => u.id === id))
    .filter((u): u is User => u !== undefined)
    .filter((u) => !q || matches(u.name, q) || (u.email !== null && matches(u.email, q)))
    .map((u) => ({
      option: {
        choice: { kind: 'friend', friendId: u.id },
        key: `friend:${u.id}`,
        name: properName(u.name),
        detail: 'Just the two of you',
        user: u,
      } satisfies ScopeOption,
      at: friendActivity.get(u.id),
    }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === undefined) return 1;
        if (b.at === undefined) return -1;
        return a.at < b.at ? 1 : -1;
      }
      return byName(a.option, b.option);
    })
    .map((x) => x.option);

  return { groups, friends };
}
