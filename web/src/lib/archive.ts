import { groupBalances, type NetBalance } from './balances';
import type { Group, SyncData } from './types';

/**
 * Personal group archive: archived groups are hidden from MY Home list only.
 * They stay in the dataset, so balances, totals, search and insights keep
 * counting them.
 */

export const isArchived = (group: Pick<Group, 'archivedAt'>): boolean => group.archivedAt != null;

/** Splits groups into the Home list and the archive, keeping their order. */
export function partitionGroups<G extends Pick<Group, 'archivedAt'>>(
  groups: readonly G[],
): { active: G[]; archived: G[] } {
  const active: G[] = [];
  const archived: G[] = [];
  for (const g of groups) (isArchived(g) ? archived : active).push(g);
  return { active, archived };
}

/**
 * Archived groups for the archive screen, most recently archived first (ties
 * keep their sync order).
 */
export function archivedGroups<G extends Pick<Group, 'archivedAt'>>(groups: readonly G[]): G[] {
  return partitionGroups(groups).archived.sort((a, b) =>
    (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''),
  );
}

/** Cache transform: sets my archivedAt on one group (null = unarchived). */
export function withGroupArchived(
  sync: SyncData,
  groupId: number,
  archivedAt: string | null,
): SyncData {
  if (!sync.groups.some((g) => g.id === groupId)) return sync;
  return {
    ...sync,
    groups: sync.groups.map((g) => (g.id === groupId ? { ...g, archivedAt } : g)),
  };
}

/** My nonzero balances in a group, one per currency. */
export function myOpenGroupBalances(sync: SyncData, groupId: number): NetBalance[] {
  return groupBalances(sync, groupId).filter((b) => b.userId === sync.me.id && b.netCents !== 0);
}
