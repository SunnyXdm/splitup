import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  ActivityRow,
  ExpenseRow,
  GroupRow,
  SettlementBatchRow,
  ShareRow,
  UserRow,
} from '../db';
import { CATEGORIES, SETTLEMENT_METHODS } from '../validate';

/** Wire shapes — mirror web/src/lib/types.ts exactly. */
export type Category = (typeof CATEGORIES)[number];

export interface User {
  id: number;
  name: string;
  email: string | null;
  picture: string | null;
  /** True for a guest participant (no account; tracked inside one group). */
  isGuest?: boolean;
}

export interface Me extends User {
  defaultCurrency: string;
}

export interface Group {
  id: number;
  name: string;
  emoji: string;
  currency: string;
  createdBy: number;
  createdAt: string;
  memberIds: number[];
  /** When the current user archived this group (hidden from their Home); null if not. */
  archivedAt: string | null;
}

export interface ExpenseShare {
  userId: number;
  paidCents: number;
  owedCents: number;
}

export interface Expense {
  id: number;
  groupId: number | null;
  description: string;
  amountCents: number;
  currency: string;
  date: string;
  category: Category;
  notes: string | null;
  isPayment: boolean;
  shares: ExpenseShare[];
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  /** The settle-up batch this payment row belongs to; null for everything else. */
  settlementBatchId: number | null;
}

export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

/** One settle-up: the cash that actually moved, and the rows it was recorded as. */
export interface SettlementBatch {
  id: number;
  payerId: number;
  payeeId: number;
  /** Net cash moved payer → payee; always positive. */
  amountCents: number;
  currency: string;
  date: string;
  method: SettlementMethod | null;
  reference: string | null;
  note: string | null;
  createdBy: number;
  createdAt: string;
  /** Live payment-row expense ids, in id order. */
  rows: number[];
}

export type ActivityType =
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'expense_restored'
  | 'payment_added'
  | 'payment_undone'
  | 'group_created'
  | 'group_renamed'
  | 'member_joined'
  | 'member_removed'
  | 'friend_added'
  | 'guest_added'
  | 'guest_renamed'
  | 'guest_removed'
  | 'guest_claimed';

export interface ActivityItem {
  id: number;
  actorId: number;
  type: ActivityType;
  groupId: number | null;
  expenseId: number | null;
  summary: string;
  createdAt: string;
}

export interface IncomingFriendRequest {
  id: number;
  user: User;
  createdAt: string;
}

/** Addressed by email only — never reveals whether an account exists. */
export interface OutgoingFriendRequest {
  id: number;
  email: string;
  createdAt: string;
}

export interface FriendRequests {
  incoming: IncomingFriendRequest[];
  outgoing: OutgoingFriendRequest[];
}

export type Cadence = 'weekly' | 'monthly' | 'yearly';

export interface RecurringSplit {
  mode: 'equal' | 'exact' | 'percent' | 'shares';
  participants: number[];
  values?: { userId: number; value: number }[];
  payers: { userId: number; cents: number }[];
}

export interface RecurringTemplate {
  description: string;
  amountCents: number;
  currency: string;
  category: Category;
  notes: string | null;
  split: RecurringSplit;
}

export interface RecurringRule {
  id: number;
  createdBy: number;
  groupId: number | null;
  friendId: number | null;
  template: RecurringTemplate;
  cadence: Cadence;
  interval: number;
  /** YYYY-MM-DD */
  anchorDate: string;
  /** YYYY-MM-DD of the next occurrence not yet generated. */
  nextDue: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A due occurrence waiting in its creator's "Due to add" inbox. */
export interface PendingOccurrence {
  id: number;
  ruleId: number;
  dueDate: string;
  description: string;
  amountCents: number;
  currency: string;
  groupId: number | null;
  friendId: number | null;
}

export interface SyncData {
  me: Me;
  users: User[];
  friendIds: number[];
  groups: Group[];
  expenses: Expense[];
  settlementBatches: SettlementBatch[];
  activity: ActivityItem[];
  friendRequests: FriendRequests;
  /** Server capabilities the client may surface. */
  features: { receiptScan: boolean };
  /** Rules I created or that live in my groups; inbox items only for my own. */
  recurring: { rules: RecurringRule[]; pending: PendingOccurrence[] };
  syncedAt: string;
}

export interface InvitePreview {
  token: string;
  groupId: number;
  groupName: string;
  emoji: string;
  memberCount: number;
  memberNames: string[];
  alreadyMember: boolean;
}

/** GET /api/guest-claims/:token — what accepting the claim link would do. */
export interface GuestClaimPreview {
  token: string;
  guest: User;
  groupId: number;
  groupName: string;
  emoji: string;
  inviter: User;
  /** The caller is already a member of the group (their shares get combined). */
  alreadyMember: boolean;
}

export const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  picture: r.picture,
  ...(r.is_guest ? { isGuest: true } : {}),
});

export const toMe = (r: UserRow): Me => ({
  id: r.id,
  name: r.name,
  email: r.email,
  picture: r.picture,
  defaultCurrency: r.default_currency,
});

export const toGroup = (
  r: GroupRow,
  memberIds: number[],
  archivedAt: string | null = null,
): Group => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  currency: r.currency,
  createdBy: r.created_by,
  createdAt: r.created_at,
  memberIds,
  archivedAt,
});

export const toShare = (s: ShareRow): ExpenseShare => ({
  userId: s.user_id,
  paidCents: s.paid_cents,
  owedCents: s.owed_cents,
});

export const toExpense = (r: ExpenseRow, shares: ShareRow[]): Expense => ({
  id: r.id,
  groupId: r.group_id,
  description: r.description,
  amountCents: r.amount_cents,
  currency: r.currency,
  date: r.date,
  category: r.category as Category,
  notes: r.notes,
  isPayment: r.is_payment === 1,
  shares: shares.map(toShare),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  settlementBatchId: r.settlement_batch_id ?? null,
});

export const toSettlementBatch = (r: SettlementBatchRow, rows: number[]): SettlementBatch => ({
  id: r.id,
  payerId: r.payer_id,
  payeeId: r.payee_id,
  amountCents: r.amount_cents,
  currency: r.currency,
  date: r.date,
  method: (r.method as SettlementMethod | null) ?? null,
  reference: r.reference,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
  rows,
});

export const toActivity = (r: ActivityRow): ActivityItem => ({
  id: r.id,
  actorId: r.actor_id,
  type: r.type as ActivityType,
  groupId: r.group_id,
  expenseId: r.expense_id,
  summary: r.summary,
  createdAt: r.created_at,
});

/** Parse the JSON body, mapping malformed JSON to a 400 instead of a 500. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
}
