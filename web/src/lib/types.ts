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
  /** When I archived this group (hidden from my Home only); null/absent if not. */
  archivedAt?: string | null;
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
  | 'expense_restored'
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

export type Cadence = 'weekly' | 'monthly' | 'yearly';

/**
 * How a recurring bill splits, stored as intent so a changed amount re-splits
 * correctly: equal stays equal, percent/shares keep ratios, exact amounts and
 * multiple payers scale proportionally.
 */
export interface RecurringSplit {
  mode: 'equal' | 'exact' | 'percent' | 'shares';
  /** Who the split may charge (equal: exactly who is charged). */
  participants: number[];
  /** exact: owed cents · percent: basis points · shares: counts. */
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
  /** The other person of a 1:1 bill. */
  friendId: number | null;
  template: RecurringTemplate;
  cadence: Cadence;
  interval: number;
  /** YYYY-MM-DD of the first occurrence; its day-of-month is kept (clamped). */
  anchorDate: string;
  /** YYYY-MM-DD of the next occurrence not yet in the inbox. */
  nextDue: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A due occurrence in my "Due to add" inbox (only the rule's creator gets these). */
export interface PendingOccurrence {
  id: number;
  ruleId: number;
  /** YYYY-MM-DD */
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
  /** Optional: absent from older servers and older persisted payloads. */
  settlementBatches?: SettlementBatch[];
  activity: ActivityItem[];
  /** Optional: absent from older servers and older persisted payloads. */
  friendRequests?: FriendRequests;
  /** Optional: absent from older servers and older persisted payloads. */
  features?: { receiptScan?: boolean };
  /** Optional: absent from older servers and older persisted payloads. */
  recurring?: { rules: RecurringRule[]; pending: PendingOccurrence[] };
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

/** An expense's user-facing state at one point in its history. */
export interface ExpenseSnapshot {
  description: string;
  amountCents: number;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  category: Category;
  notes: string | null;
  groupId: number | null;
  isPayment: boolean;
  shares: ExpenseShare[];
}

export type RevisionAction = 'created' | 'updated' | 'deleted' | 'restored';

export interface ExpenseRevision {
  revision: number;
  action: RevisionAction;
  actorId: number;
  createdAt: string;
  snapshot: ExpenseSnapshot;
}

/** GET /api/expenses/:id/revisions — newest first; `users` names everyone it mentions. */
export interface ExpenseRevisions {
  revisions: ExpenseRevision[];
  users: User[];
}

export interface DeletedExpense extends Expense {
  deletedAt: string;
  /** Who deleted it; null when unknown. */
  deletedBy: number | null;
  /** Its latest revision — what restoring brings back. */
  revision: number;
}

/** GET /api/expenses/deleted — the last 90 days, most recently deleted first. */
export interface DeletedExpenses {
  expenses: DeletedExpense[];
  users: User[];
}
