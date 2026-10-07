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
  /** Settle-up batch this payment row belongs to. Optional: absent from older caches. */
  settlementBatchId?: number | null;
}

export type SettlementMethod = 'cash' | 'upi' | 'bank' | 'other';

/** One settle-up: the cash that actually moved, and the payment rows it was recorded as. */
export interface SettlementBatch {
  id: number;
  payerId: number;
  payeeId: number;
  /** Net cash moved payer → payee; always positive. */
  amountCents: number;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  method: SettlementMethod | null;
  reference: string | null;
  note: string | null;
  createdBy: number;
  createdAt: string;
  /** Live payment-row expense ids. */
  rows: number[];
}

export type ActivityType =
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'payment_added'
  | 'payment_undone'
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

export interface IncomingFriendRequest {
  id: number;
  /** Who asked (full profile — they revealed themselves by asking). */
  user: User;
  createdAt: string;
}

export interface OutgoingFriendRequest {
  id: number;
  /** Only the email I typed — never reveals whether it has an account. */
  email: string;
  createdAt: string;
}

export interface FriendRequests {
  incoming: IncomingFriendRequest[];
  /** Requests I sent that are still pending. */
  outgoing: OutgoingFriendRequest[];
}

export interface SyncData {
  me: Me;
  users: User[];
  friendIds: number[];
  groups: Group[];
  expenses: Expense[];
  /** Optional: absent from older servers and older persisted payloads. */
  settlementBatches?: SettlementBatch[];
  activity: ActivityItem[];
  /** Optional: absent from older servers and older persisted payloads. */
  friendRequests?: FriendRequests;
  /** Optional: absent from older servers and older persisted payloads. */
  features?: { receiptScan?: boolean };
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

export interface ReceiptLineItem {
  name: string;
  quantity: number | null;
  amountCents: number;
}

/** POST /api/receipts/scan — amounts are minor units of `currency`. */
export interface ReceiptDraft {
  merchant: string | null;
  date: string | null;
  currency: string | null;
  totalCents: number | null;
  subtotalCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  discountCents: number | null;
  lineItems: ReceiptLineItem[];
  category: Category;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export interface ReceiptScanResult {
  draft: ReceiptDraft;
  warnings: string[];
  model: string;
}
