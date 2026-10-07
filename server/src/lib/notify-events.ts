import { db, type UserRow } from '../db';
import { notifyUsers } from '../notify';
import { groupMemberIds, userName } from './expense';
import {
  addedToGroupPayload,
  expensePayload,
  friendAcceptedPayload,
  friendRequestPayload,
  settlementPayload,
  settlementUndonePayload,
  type PayloadShare,
} from './push-payload';

/**
 * Domain-level push triggers. Each one is called after its write transaction
 * commits; recipients exclude the actor, and the lookups needed to word the
 * message run in notifyUsers' deferred job, not on the request path.
 */

type Actor = Pick<UserRow, 'id' | 'name'>;

export interface NotifyExpense {
  id: number;
  groupId: number | null;
  description: string;
  currency: string;
  isPayment: boolean;
  shares: PayloadShare[];
}

const groupName = (groupId: number) =>
  db.prepare<[number], { name: string }>('SELECT name FROM groups WHERE id = ?').get(groupId)
    ?.name ?? null;

/**
 * Expense created / edited / deleted: everyone holding a share (for edits,
 * before OR after — someone dropped from the split should hear about it).
 * In a group, only current members: a departed member can't open the group.
 */
export function notifyExpense(
  kind: 'created' | 'edited' | 'deleted',
  actor: Actor,
  expense: NotifyExpense,
  previousShareUserIds: number[] = [],
): void {
  const ids = new Set([...expense.shares.map((s) => s.userId), ...previousShareUserIds]);
  ids.delete(actor.id);
  if (ids.size === 0) return;
  const actorSnap = { id: actor.id, name: actor.name };
  const snapshot = { ...expense, shares: expense.shares.map((s) => ({ ...s })) };
  let ctx: { groupName: string | null; members: Set<number> | null; names: Map<number, string> } | null =
    null;
  const context = () => {
    if (ctx) return ctx;
    const names = new Map<number, string>();
    if (snapshot.isPayment) for (const s of snapshot.shares) names.set(s.userId, userName(s.userId));
    ctx =
      snapshot.groupId === null
        ? { groupName: null, members: null, names }
        : {
            groupName: groupName(snapshot.groupId),
            members: new Set(groupMemberIds(snapshot.groupId)),
            names,
          };
    return ctx;
  };
  notifyUsers(ids, (uid) => {
    const c = context();
    if (c.members && !c.members.has(uid)) return null;
    return expensePayload(
      kind,
      actorSnap,
      uid,
      {
        expenseId: snapshot.id,
        groupId: snapshot.groupId,
        groupName: c.groupName,
        description: snapshot.description,
        currency: snapshot.currency,
        isPayment: snapshot.isPayment,
        shares: snapshot.shares,
      },
      c.names,
    );
  });
}

/** A settle-up batch: one notification to the counterparty with the net amount. */
export function notifySettlement(
  actor: Actor,
  counterpartyId: number,
  rows: { payerId: number; recipientId: number; amountCents: number }[],
  currency: string,
): void {
  if (counterpartyId === actor.id) return;
  notifyUsers(
    [counterpartyId],
    settlementPayload({ id: actor.id, name: actor.name }, counterpartyId, rows, currency),
  );
}

/** A settle-up batch was undone: one notification to the other party. */
export function notifySettlementUndone(
  actor: Actor,
  batch: { payerId: number; payeeId: number; amountCents: number; currency: string },
): void {
  const other = batch.payerId === actor.id ? batch.payeeId : batch.payerId;
  if (other === actor.id) return;
  notifyUsers([other], settlementUndonePayload({ id: actor.id, name: actor.name }, batch));
}

/**
 * Friend requests are addressed by email: notify only when an account with
 * that email exists (otherwise nobody to tell). Lookup is deferred too, so
 * the response timing never hints at whether the account exists.
 */
export function notifyFriendRequest(actor: Actor, toEmail: string): void {
  const actorSnap = { id: actor.id, name: actor.name };
  const email = toEmail.toLowerCase();
  setImmediate(() => {
    try {
      const target = db
        .prepare<[string, number], { id: number }>(
          'SELECT id FROM users WHERE lower(email) = ? AND id != ? ORDER BY id LIMIT 1',
        )
        .get(email, actorSnap.id);
      if (target) notifyUsers([target.id], friendRequestPayload(actorSnap));
    } catch {
      // best effort
    }
  });
}

export function notifyFriendAccepted(actor: Actor, friendId: number, via: 'request' | 'invite'): void {
  if (friendId === actor.id) return;
  notifyUsers([friendId], friendAcceptedPayload({ id: actor.id, name: actor.name }, via));
}

export function notifyAddedToGroup(
  actor: Actor,
  userId: number,
  group: { id: number; name: string },
): void {
  if (userId === actor.id) return;
  notifyUsers(
    [userId],
    addedToGroupPayload({ id: actor.id, name: actor.name }, { id: group.id, name: group.name }),
  );
}
