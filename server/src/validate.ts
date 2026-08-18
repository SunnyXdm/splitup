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

const MAX_CENTS = 100_000_000;
const currency = z.string().regex(/^[A-Z]{3}$/);
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export const expenseBody = z
  .strictObject({
    groupId: z.number().int().positive().nullable(),
    description: z.string().trim().min(1).max(200),
    amountCents: z.number().int().min(1).max(MAX_CENTS),
    currency,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)), 'invalid date'),
    category: z.enum(CATEGORIES),
    notes: z.string().trim().max(1000).nullable(),
    isPayment: z.boolean(),
    shares: z.array(shareSchema).min(1).max(50),
  })
  .superRefine((e, ctx) => {
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
  });

export type ExpenseBody = z.infer<typeof expenseBody>;

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
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)), 'invalid date'),
    /**
     * Freshness fingerprint of the pair-scope expenses the client's breakdown
     * was computed from: max updatedAt + row count. Any difference → 409.
     */
    watermark: z.string().max(40).optional(),
    watermarkCount: z.number().int().min(0).optional(),
    rows: z.array(settleRow).min(1).max(30),
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
