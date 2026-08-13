export type Category =
  | 'general'
  | 'food'
  | 'groceries'
  | 'transport'
  | 'home'
  | 'utilities'
  | 'travel'
  | 'shopping'
  | 'entertainment'
  | 'health';

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
  /** YYYY-MM-DD */
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

export interface FriendInvitePreview {
  token: string;
  inviter: User;
  isSelf: boolean;
  alreadyFriends: boolean;
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

export interface ExpenseInput {
  groupId: number | null;
  description: string;
  amountCents: number;
  currency: string;
  date: string;
  category: Category;
  notes: string | null;
  isPayment: boolean;
  shares: ExpenseShare[];
}
