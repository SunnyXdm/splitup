import { z } from 'zod';

export const CATEGORIES = [
  'general',
  'food',
  'groceries',
  'transport',
  'home',
  'utilities',
  'travel',
  'shopping',
  'entertainment',
  'health',
] as const;

/** How a settle-up's cash moved; optional detail on the batch. */
export const SETTLEMENT_METHODS = ['cash', 'upi', 'bank', 'other'] as const;

/** Trimmed optional text; blank → undefined so the column stores NULL. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : undefined));

export const MAX_CENTS = 100_000_000;
const currency = z.string().regex(/^[A-Z]{3}$/);
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A real calendar date: YYYY-MM-DD that survives a UTC round-trip (no 2024-02-30). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  }, 'invalid date');

/** Client-generated idempotency key for create retries. */
const clientKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'invalid clientKey');

export const idParam = z.coerce.number().int().positive();
export const inviteTokenParam = z.string().regex(/^[0-9a-f]{16,64}$/);

export const sessionBody = z.strictObject({
  idToken: z.string().min(10).max(8192),
});

export const meBody = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  defaultCurrency: currency.optional(),
});

export const groupCreateBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  emoji: z.string().min(1).max(8).optional(),
  currency: currency.optional(),
});

export const groupPatchBody = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  emoji: z.string().min(1).max(8).optional(),
  currency: currency.optional(),
});

export const memberBody = z.strictObject({
  userId: z.number().int().positive(),
});

export const friendBody = z.strictObject({
  email: z.string().trim().toLowerCase().regex(emailRe).max(254),
});

const shareSchema = z.strictObject({
  userId: z.number().int().positive(),
  paidCents: z.number().int().min(0).max(MAX_CENTS),
  owedCents: z.number().int().min(0).max(MAX_CENTS),
});

const expenseFields = z.strictObject({
  groupId: z.number().int().positive().nullable(),
  description: z.string().trim().min(1).max(200),
  amountCents: z.number().int().min(1).max(MAX_CENTS),
  currency,
  date: isoDate,
  category: z.enum(CATEGORIES),
  notes: z.string().trim().max(1000).nullable(),
  isPayment: z.boolean(),
  shares: z.array(shareSchema).min(1).max(50),
});

function refineExpense(e: z.infer<typeof expenseFields>, ctx: z.RefinementCtx): void {
  const userIds = new Set(e.shares.map((s) => s.userId));
  if (userIds.size !== e.shares.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate share user' });
  }
  const paid = e.shares.reduce((sum, s) => sum + s.paidCents, 0);
  const owed = e.shares.reduce((sum, s) => sum + s.owedCents, 0);
  if (paid !== e.amountCents || owed !== e.amountCents) {
    ctx.addIssue({ code: 'custom', message: 'shares must sum to the amount' });
  }
  if (e.groupId === null && e.shares.length !== 2) {
    ctx.addIssue({ code: 'custom', message: 'non-group expenses need exactly 2 people' });
  }
  // Payments are strictly one payer → one recipient; every display and
  // summary assumes it, and self-payments are meaningless no-ops.
  if (
    e.isPayment &&
    !(
      e.shares.length === 2 &&
      e.shares.some((s) => s.paidCents === e.amountCents && s.owedCents === 0) &&
      e.shares.some((s) => s.paidCents === 0 && s.owedCents === e.amountCents)
    )
  ) {
    ctx.addIssue({ code: 'custom', message: 'a payment needs exactly one payer and one recipient' });
  }
}

export const expenseCreateBody = expenseFields
  .extend({ clientKey: clientKeySchema.optional() })
  .superRefine(refineExpense);

export const expensePatchBody = expenseFields
  .extend({
    /** The updatedAt the client last saw; a mismatch → 409 conflict. */
    expectedUpdatedAt: z.string().max(40).optional(),
  })
  .superRefine(refineExpense);

export type ExpenseBody = z.infer<typeof expenseFields>;

/** A stored revision snapshot, re-validated before it may be restored. */
export const expenseSnapshotSchema = expenseFields.superRefine(refineExpense);

export const expenseRestoreBody = z.strictObject({
  revision: z.number().int().positive(),
  /** The updatedAt the client last saw; a mismatch → 409 conflict. */
  expectedUpdatedAt: z.string().max(40).optional(),
});

/** GET /api/expenses/deleted scope: one group, one friend, or (neither) everything. */
export const deletedExpensesQuery = z
  .strictObject({
    groupId: z.coerce.number().int().positive().optional(),
    friendId: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => q.groupId === undefined || q.friendId === undefined, {
    message: 'pass groupId or friendId, not both',
  });

const settleRow = z.strictObject({
  groupId: z.number().int().positive().nullable(),
  payerId: z.number().int().positive(),
  recipientId: z.number().int().positive(),
  amountCents: z.number().int().min(1).max(MAX_CENTS),
});

/** A batch of payment rows settling one friend balance atomically. */
export const settlementsBody = z
  .strictObject({
    counterpartyId: z.number().int().positive(),
    currency,
    date: isoDate,
    clientKey: clientKeySchema.optional(),
    /**
     * Freshness fingerprint of the pair-scope expenses the client's breakdown
     * was computed from: max updatedAt + row count. Any difference → 409.
     */
    watermark: z.string().max(40).optional(),
    watermarkCount: z.number().int().min(0).optional(),
    rows: z.array(settleRow).min(1).max(64),
    method: z.enum(SETTLEMENT_METHODS).nullable().optional(),
    reference: optionalText(100),
    note: optionalText(500),
  })
  .superRefine((b, ctx) => {
    if ((b.watermark === undefined) !== (b.watermarkCount === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'watermark and watermarkCount go together' });
    }
    let directForward = 0;
    let directBack = 0;
    for (const r of b.rows) {
      if (r.payerId === r.recipientId) {
        ctx.addIssue({ code: 'custom', message: 'payer and recipient must differ' });
      }
      if (r.groupId === null) {
        if (r.payerId === b.counterpartyId) directForward++;
        else directBack++;
      }
    }
    if (directForward > 1 || directBack > 1) {
      ctx.addIssue({ code: 'custom', message: 'at most one direct row per direction' });
    }
  });

export type SettlementsBody = z.infer<typeof settlementsBody>;

const base64url = (max: number) =>
  z
    .string()
    .min(16)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'must be base64url');

/**
 * A push endpoint is a URL the SERVER will POST to, so beyond "https" refuse
 * anything that names a local/internal host: IP literals, localhost and
 * single-label names. Real push services are public DNS names.
 */
export const pushEndpoint = z
  .string()
  .max(1000)
  .refine((raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      u.username === '' &&
      u.password === '' &&
      host.includes('.') &&
      !host.startsWith('[') &&
      !/^\d+(\.\d+){3}$/.test(host) &&
      !/(^|\.)(localhost|local|internal|localdomain)$/.test(host)
    );
  }, 'endpoint must be a public https URL');

/** Shape of PushSubscription.toJSON(). */
export const pushSubscriptionBody = z.strictObject({
  endpoint: pushEndpoint,
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: base64url(200),
    auth: base64url(100),
  }),
});

export const pushUnsubscribeBody = z.strictObject({
  endpoint: z.string().min(1).max(1000),
});
