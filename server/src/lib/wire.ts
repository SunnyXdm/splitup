import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ActivityRow, ExpenseRow, GroupRow, ShareRow, UserRow } from '../db';
import { CATEGORIES } from '../validate';

/** Wire shapes — mirror web/src/lib/types.ts exactly. */
export type Category = (typeof CATEGORIES)[number];

export interface User {
  id: number;
  name: string;
  email: string | null;
  picture: string | null;
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
}

export type ActivityType =
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'payment_added'
  | 'group_created'
  | 'group_renamed'
  | 'member_joined'
  | 'member_removed'
  | 'friend_added';

export interface ActivityItem {
  id: number;
  actorId: number;
  type: ActivityType;
  groupId: number | null;
  expenseId: number | null;
  summary: string;
  createdAt: string;
}

export interface SyncData {
  me: Me;
  users: User[];
  friendIds: number[];
  groups: Group[];
  expenses: Expense[];
  activity: ActivityItem[];
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

export const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  email: r.email,
  picture: r.picture,
});

export const toMe = (r: UserRow): Me => ({ ...toUser(r), defaultCurrency: r.default_currency });

export const toGroup = (r: GroupRow, memberIds: number[]): Group => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  currency: r.currency,
  createdBy: r.created_by,
  createdAt: r.created_at,
  memberIds,
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
