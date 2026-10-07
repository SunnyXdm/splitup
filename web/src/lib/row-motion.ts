/**
 * Bookkeeping that lets expense lists animate only genuine changes:
 * - an optimistic row swapped for its server row keeps its React key (so it
 *   neither re-enters nor cuts its highlight short), and
 * - a row I just deleted gets a short exit before it leaves the list
 *   (filters or refetches dropping rows never animate).
 */

/** server id → the temp (negative) id its optimistic row had. */
const tempOf = new Map<number, number>();
const justDeleted = new Set<number>();
const DELETED_TTL_MS = 2_000;

export function noteResolvedTemp(tempId: number, serverId: number): void {
  tempOf.set(serverId, tempId);
}

/** The id to key a row by: the optimistic row's temp id, once resolved. */
export function stableRowId(id: number): number {
  return tempOf.get(id) ?? id;
}

export function noteDeleted(id: number): void {
  // Lists may still hold the row as its optimistic self (same key), so the
  // temp id it was created under counts as deleted too.
  const ids = [id, tempOf.get(id)].filter((x): x is number => x !== undefined);
  for (const x of ids) justDeleted.add(x);
  setTimeout(() => {
    for (const x of ids) justDeleted.delete(x);
  }, DELETED_TTL_MS);
}

export function wasJustDeleted(id: number): boolean {
  return justDeleted.has(id);
}
