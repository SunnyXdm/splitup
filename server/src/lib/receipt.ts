/**
 * Pure helpers for receipt scanning: the strict output schema handed to the
 * model, input image validation, and normalization of the model's answer into
 * a draft the client can prefill. No I/O here — see ../receipts.ts.
 */
import { z } from 'zod';
import { CATEGORIES, MAX_CENTS } from '../validate';
import { currencyDigits, isSupportedCurrency } from './currency';
import { isPartial } from './partial-json';
import { checkReceipt, parsePrintedAmount } from './receipt-checks';
import type { PartialFields } from './scan-events';

export type Category = (typeof CATEGORIES)[number];

// ---------------------------------------------------------------- image input

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type ImageMime = keyof typeof MIME_EXT;

export interface DecodedImage {
  mime: ImageMime;
  ext: string;
  bytes: Buffer;
}

function magicMatches(mime: ImageMime, b: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg':
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return (
        b.length > 8 &&
        b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/webp':
      return (
        b.length > 12 &&
        b.subarray(0, 4).toString('latin1') === 'RIFF' &&
        b.subarray(8, 12).toString('latin1') === 'WEBP'
      );
  }
}

/**
 * Decode a `data:image/…;base64,` URL. Returns an error string (safe to show)
 * instead of throwing, and never echoes the payload.
 */
export function decodeImageDataUrl(dataUrl: string): DecodedImage | { error: string } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { error: 'image must be a base64 JPEG, PNG or WebP data URL' };
  const mime = m[1] as ImageMime;
  const b64 = m[2]!;
  // Cheap pre-check before allocating: 4 base64 chars encode 3 bytes.
  if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES + 3) return { error: 'image too large' };
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) return { error: 'empty image' };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: 'image too large' };
  if (!magicMatches(mime, bytes)) return { error: 'image content does not match its type' };
  return { mime, ext: MIME_EXT[mime], bytes };
}

// -------------------------------------------------------- model output schema

const nullable = (type: 'string' | 'integer' | 'number', description?: string) =>
  ({ type: [type, 'null'], ...(description ? { description } : {}) }) as const;

export const TAX_KINDS = [
  'CGST',
  'SGST',
  'UTGST',
  'IGST',
  'CESS',
  'GST',
  'VAT',
  'SSCL',
  'SALES_TAX',
  'OTHER',
] as const;
export const FEE_KINDS = [
  'SERVICE_CHARGE',
  'TIP',
  'DELIVERY',
  'PACKAGING',
  'ROUND_OFF',
  'OTHER',
] as const;
export const FIELD_NAMES = [
  'merchant',
  'date',
  'currency',
  'line_items',
  'subtotal',
  'discounts',
  'taxes',
  'fees',
  'total',
] as const;

/**
 * JSON Schema for the model's answer: Claude structured outputs
 * (output_config.format) and `codex exec --output-schema` alike. Strict mode
 * wants every property required and additionalProperties:false at each
 * level; optional data is a nullable type (Claude allows ≤16 of those per
 * request — this uses 13). Property order is the streaming order, so header
 * fields arrive first. Raw printed text sits next to each normalized value.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'merchant',
    'location',
    'gstin',
    'date_raw',
    'date',
    'currency_raw',
    'currency',
    'line_items',
    'subtotal_minor',
    'discounts',
    'taxes',
    'fees',
    'total_raw',
    'total_minor',
    'category',
    'confidence',
    'illegible_fields',
    'uncertain_fields',
    'notes',
  ],
  properties: {
    merchant: nullable('string', 'Business name as printed'),
    location: nullable('string', 'Address/city/country/phone cues as printed, condensed'),
    gstin: nullable('string', 'Indian GSTIN exactly as printed (15 chars), else null'),
    date_raw: nullable('string', 'Transaction date exactly as printed'),
    date: nullable('string', 'Transaction date as YYYY-MM-DD'),
    currency_raw: nullable('string', 'Currency marker as printed, e.g. "Rs.", "₹", "LKR"'),
    currency: nullable('string', 'ISO 4217 code'),
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['raw_text', 'name', 'quantity', 'amount_minor'],
        properties: {
          raw_text: { type: 'string', description: 'The printed line, verbatim' },
          name: { type: 'string' },
          quantity: nullable('number'),
          amount_minor: { type: 'integer', description: 'Line amount in minor units' },
        },
      },
    },
    subtotal_minor: nullable('integer'),
    discounts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'amount_minor'],
        properties: {
          label: { type: 'string' },
          amount_minor: { type: 'integer', description: 'Positive number' },
        },
      },
    },
    taxes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'label', 'rate_percent', 'amount_minor', 'inclusive'],
        properties: {
          kind: { type: 'string', enum: [...TAX_KINDS] },
          label: { type: 'string', description: 'As printed, e.g. "CGST @2.5%"' },
          rate_percent: nullable('number'),
          amount_minor: { type: 'integer' },
          inclusive: {
            type: 'boolean',
            description: 'true when already included in the item prices',
          },
        },
      },
    },
    fees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'label', 'amount_minor'],
        properties: {
          kind: { type: 'string', enum: [...FEE_KINDS] },
          label: { type: 'string' },
          amount_minor: { type: 'integer', description: 'Negative for a round-off down' },
        },
      },
    },
    total_raw: nullable('string', 'Grand total exactly as printed'),
    total_minor: nullable('integer'),
    category: { type: 'string', enum: [...CATEGORIES] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    illegible_fields: { type: 'array', items: { type: 'string', enum: [...FIELD_NAMES] } },
    uncertain_fields: { type: 'array', items: { type: 'string', enum: [...FIELD_NAMES] } },
    notes: nullable('string'),
  },
} as const;

/** Stable instructions (the system prompt); per-scan hints go in the user turn. */
export const RECEIPT_INSTRUCTIONS = [
  'You read photos of shop and restaurant receipts for a bill-splitting app and return the required JSON.',
  'Transcribe; never invent. Report only what is visibly printed. If a value is missing use null; if it is printed but unreadable, use null and list the field in illegible_fields. List fields you read but are unsure of in uncertain_fields.',
  'Amounts:',
  '- Every *_minor value is an integer in the minor units of the receipt currency (INR/LKR/USD 780.00 -> 78000; JPY 1200 -> 1200; BHD 1.250 -> 1250).',
  '- Copy total_raw exactly as printed (e.g. "Rs. 1,23,456.00"); the app re-parses it. Indian bills group digits as 1,23,456.',
  '- line_items: each purchased item with its printed line amount; raw_text is the line verbatim. Write "[illegible]" for an unreadable name but keep the amount. Do not list tax, charges, discounts or totals as items.',
  '- discounts: each discount line as a positive amount.',
  '- taxes: one entry per tax line (CGST, SGST, UTGST, IGST, cess, GST, VAT, SSCL, sales tax) with its printed rate. Set inclusive=true when the bill says prices include the tax (e.g. "VAT included", "incl. of all taxes").',
  '- fees: service charge, tip, delivery, packaging, round-off (negative when it reduces the total).',
  '- total_minor is the final amount payable.',
  'Currency:',
  '- currency_raw is the marker as printed; currency is the ISO 4217 code.',
  '- "Rs", "Rs." and "/-" are used in India (INR), Sri Lanka (LKR), Pakistan (PKR) and Nepal (NPR). Decide from other cues: GSTIN, CGST/SGST/IGST, HSN/SAC, FSSAI, a 6-digit PIN code, Indian states or +91 mean INR; VAT registration numbers with SSCL, Sri Lankan towns (Colombo, Kandy, Galle…), Sinhala text or +94 mean LKR. ₹ is always INR; රු is LKR.',
  '- If nothing on the receipt settles it, prefer the hinted currencies below, add "currency" to uncertain_fields and lower confidence to medium.',
  'Date: copy date_raw as printed. Read numeric dates as day/month/year unless the receipt is clearly from the US or the hinted locale is en-US. Use null for date if it is not printed.',
  'gstin: the 15-character GSTIN if printed, else null. location: a short summary of address/phone cues.',
  `category: the best fit among ${CATEGORIES.join(', ')}.`,
  'confidence: low if the photo is blurry, cropped or not a receipt; medium if some values were hard to read.',
  'notes: one short remark only if something important is unclear (e.g. "total partially cut off"); else null.',
  'Respond with the JSON only.',
].join('\n');

export interface ScanHints {
  /** The currency of the form/group the expense is going into. */
  formCurrency: string | null;
  /** The user's default currency. */
  defaultCurrency: string | null;
  /** The device locale, e.g. "en-IN". */
  locale: string | null;
  /** YYYY-MM-DD in the server's view, for the "not in the future" rule. */
  today: string;
}

/** The per-scan text that follows the image. */
export function receiptUserPrompt(hints: ScanHints, recheck: string[] = []): string {
  const lines = ['Extract this receipt.', 'Hints (context, not facts):'];
  if (hints.formCurrency) lines.push(`- The expense is being added in ${hints.formCurrency}.`);
  if (hints.defaultCurrency && hints.defaultCurrency !== hints.formCurrency) {
    lines.push(`- The user's default currency is ${hints.defaultCurrency}.`);
  }
  if (hints.locale) lines.push(`- The user's device locale is ${hints.locale}.`);
  lines.push(`- Today is ${hints.today}; a receipt can't be dated later than that.`);
  if (recheck.length > 0) {
    lines.push(
      'A first automated read of this receipt failed these checks. Re-read the relevant lines carefully; report what is printed even if it still does not add up:',
      ...recheck.map((r) => `- ${r}`),
    );
  }
  return lines.join('\n');
}

/** Kept for the Codex provider, which takes a single prompt string. */
export function codexPrompt(hints: ScanHints): string {
  return `${RECEIPT_INSTRUCTIONS}\n\n${receiptUserPrompt(hints)}\nDo not run any commands; just read the image and answer.`;
}

const fieldName = z.enum(FIELD_NAMES);

/** What the model must have produced (shape only; values are vetted below). */
export const rawReceiptSchema = z.object({
  merchant: z.string().nullable(),
  location: z.string().nullable(),
  gstin: z.string().nullable(),
  date_raw: z.string().nullable(),
  date: z.string().nullable(),
  currency_raw: z.string().nullable(),
  currency: z.string().nullable(),
  line_items: z.array(
    z.object({
      raw_text: z.string(),
      name: z.string(),
      quantity: z.number().nullable(),
      amount_minor: z.number().int(),
    }),
  ),
  subtotal_minor: z.number().int().nullable(),
  discounts: z.array(z.object({ label: z.string(), amount_minor: z.number().int() })),
  taxes: z.array(
    z.object({
      kind: z.string(),
      label: z.string(),
      rate_percent: z.number().nullable(),
      amount_minor: z.number().int(),
      inclusive: z.boolean(),
    }),
  ),
  fees: z.array(z.object({ kind: z.string(), label: z.string(), amount_minor: z.number().int() })),
  total_raw: z.string().nullable(),
  total_minor: z.number().int().nullable(),
  category: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  illegible_fields: z
    .array(z.string())
    .transform((a) => a.filter((f) => fieldName.safeParse(f).success)),
  uncertain_fields: z
    .array(z.string())
    .transform((a) => a.filter((f) => fieldName.safeParse(f).success)),
  notes: z.string().nullable(),
});
export type RawReceipt = z.input<typeof rawReceiptSchema>;

// ------------------------------------------------------------- normalization

export interface ReceiptLineItem {
  name: string;
  quantity: number | null;
  amountCents: number;
}

export interface ReceiptTax {
  kind: (typeof TAX_KINDS)[number];
  label: string;
  ratePercent: number | null;
  amountCents: number;
  inclusive: boolean;
}

export interface ReceiptFee {
  kind: (typeof FEE_KINDS)[number];
  label: string;
  amountCents: number;
}

export interface ReceiptDiscount {
  label: string;
  amountCents: number;
}

/** Wire shape returned to the client (mirrors web/src/lib/types.ts). */
export interface ReceiptDraft {
  merchant: string | null;
  date: string | null;
  dateRaw: string | null;
  currency: string | null;
  currencyRaw: string | null;
  totalCents: number | null;
  subtotalCents: number | null;
  /** Sum of taxes added on top of the items (inclusive taxes excluded). */
  taxCents: number | null;
  /** Sum of service charge, tip, delivery, packaging and round-off. */
  tipCents: number | null;
  discountCents: number | null;
  taxes: ReceiptTax[];
  fees: ReceiptFee[];
  discounts: ReceiptDiscount[];
  lineItems: ReceiptLineItem[];
  gstin: string | null;
  category: Category;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
}

export interface NormalizedReceipt {
  draft: ReceiptDraft;
  warnings: string[];
  /** Fields the warnings point at (for highlighting in the form). */
  warningFields: string[];
  /** Reasons a stronger model should take a second look (empty = fine). */
  recheck: string[];
}

const MAX_ITEMS = 100;
const MAX_LINES = 20;

function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

const cleanText = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  // Collapse whitespace/control chars so model output can't smuggle layout.
  const t = s
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, max);
  return t === '' ? null : t;
};

/** Non-negative, within the app's max; otherwise dropped. */
const part = (v: number | null): number | null =>
  v !== null && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS ? v : null;

const signed = (v: number): boolean => Number.isSafeInteger(v) && Math.abs(v) <= MAX_CENTS;

/** The model's currency → a supported ISO code, or null. */
function cleanCurrency(c: string | null): string | null {
  const code = c?.trim().toUpperCase() ?? null;
  return code !== null && /^[A-Z]{3}$/.test(code) && isSupportedCurrency(code) ? code : null;
}

/**
 * Vet the model's answer. Anything implausible is nulled out (never fails the
 * whole scan) and explained in `warnings`; arithmetic/format failures from
 * ./receipt-checks also land in `recheck`, which drives escalation.
 * `today` (YYYY-MM-DD) is injectable for tests.
 */
export function normalizeReceipt(
  raw: unknown,
  today: string = new Date().toISOString().slice(0, 10),
): NormalizedReceipt {
  const r = rawReceiptSchema.parse(raw);
  const warnings: string[] = [];
  const fields = new Set<string>();
  const recheck: string[] = [];
  const warn = (field: string, message: string, escalate = false) => {
    warnings.push(message);
    fields.add(field);
    if (escalate) recheck.push(message);
  };

  let currency = cleanCurrency(r.currency);
  if (r.currency !== null && currency === null) {
    warn('currency', `Unrecognized currency "${r.currency.trim().slice(0, 8)}".`);
  }
  const digits = currencyDigits(currency ?? 'USD');

  let date = r.date?.trim() ?? null;
  if (date !== null && !isCalendarDate(date)) {
    warn('date', "Couldn't read the receipt date.");
    date = null;
  }

  // Code, not the model, decides how printed digits map to minor units.
  let totalCents = r.total_minor;
  const printed = r.total_raw !== null ? parsePrintedAmount(r.total_raw, digits) : null;
  if (printed !== null && printed > 0 && totalCents !== printed) {
    if (totalCents !== null) {
      recheck.push(`total_minor ${totalCents} disagrees with the printed total "${r.total_raw}".`);
    }
    totalCents = printed;
  }
  if (
    totalCents !== null &&
    !(Number.isSafeInteger(totalCents) && totalCents > 0 && totalCents <= MAX_CENTS)
  ) {
    warn('total', 'The total on the receipt looks implausible.', true);
    totalCents = null;
  } else if (totalCents === null) {
    warn('total', "Couldn't find the total — enter the amount yourself.", true);
  }

  const lineItems: ReceiptLineItem[] = [];
  for (const it of r.line_items.slice(0, MAX_ITEMS)) {
    const name = cleanText(it.name, 120);
    if (name === null || part(it.amount_minor) === null) continue;
    const quantity =
      it.quantity !== null &&
      Number.isFinite(it.quantity) &&
      it.quantity > 0 &&
      it.quantity < 10_000
        ? it.quantity
        : null;
    lineItems.push({ name, quantity, amountCents: it.amount_minor });
  }
  if (r.line_items.length > lineItems.length) {
    warn('line_items', 'Some line items were unreadable and were skipped.');
  }

  const taxes: ReceiptTax[] = [];
  for (const t of r.taxes.slice(0, MAX_LINES)) {
    if (part(t.amount_minor) === null) continue;
    const kind = (TAX_KINDS as readonly string[]).includes(t.kind)
      ? (t.kind as ReceiptTax['kind'])
      : 'OTHER';
    const rate =
      t.rate_percent !== null &&
      Number.isFinite(t.rate_percent) &&
      t.rate_percent >= 0 &&
      t.rate_percent <= 100
        ? t.rate_percent
        : null;
    taxes.push({
      kind,
      label: cleanText(t.label, 60) ?? kind,
      ratePercent: rate,
      amountCents: t.amount_minor,
      inclusive: t.inclusive,
    });
  }
  const fees: ReceiptFee[] = [];
  for (const f of r.fees.slice(0, MAX_LINES)) {
    if (!signed(f.amount_minor) || f.amount_minor === 0) continue;
    const kind = (FEE_KINDS as readonly string[]).includes(f.kind)
      ? (f.kind as ReceiptFee['kind'])
      : 'OTHER';
    // Only a round-off may be negative.
    if (f.amount_minor < 0 && kind !== 'ROUND_OFF') continue;
    fees.push({ kind, label: cleanText(f.label, 60) ?? kind, amountCents: f.amount_minor });
  }
  const discounts: ReceiptDiscount[] = [];
  for (const d of r.discounts.slice(0, MAX_LINES)) {
    const amount = Math.abs(d.amount_minor);
    if (part(amount) === null || amount === 0) continue;
    discounts.push({ label: cleanText(d.label, 60) ?? 'Discount', amountCents: amount });
  }
  const subtotalCents = part(r.subtotal_minor);
  const gstin = cleanText(r.gstin, 20)?.replace(/\s+/g, '').toUpperCase() ?? null;

  const issues = checkReceipt({
    digits,
    totalCents,
    subtotalCents,
    itemCents: lineItems.map((it) => it.amountCents),
    taxes,
    feeCents: fees.map((f) => f.amountCents),
    discountCents: discounts.map((d) => d.amountCents),
    gstin,
    date,
    dateRaw: cleanText(r.date_raw, 40),
    today,
  });
  for (const issue of issues) {
    if (issue.field === 'date' && /future|looks wrong/.test(issue.message)) date = null;
    // A misread GSTIN never changes who owes what: warn, don't escalate.
    warn(issue.field, issue.message, issue.field !== 'gstin');
  }

  for (const f of r.illegible_fields) {
    fields.add(f);
    if (f === 'total' || f === 'currency') recheck.push(`${f} was marked illegible.`);
  }
  for (const f of r.uncertain_fields) {
    fields.add(f);
    if (f === 'total') recheck.push('The total was marked uncertain.');
  }
  if (r.confidence === 'low') recheck.push('The first read reported low confidence.');

  const sumOf = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) : null);
  const category = (CATEGORIES as readonly string[]).includes(r.category)
    ? (r.category as Category)
    : 'general';

  return {
    draft: {
      merchant: cleanText(r.merchant, 200),
      date,
      dateRaw: cleanText(r.date_raw, 40),
      currency,
      currencyRaw: cleanText(r.currency_raw, 16),
      totalCents,
      subtotalCents,
      taxCents: sumOf(taxes.filter((t) => !t.inclusive).map((t) => t.amountCents)),
      tipCents: sumOf(fees.map((f) => f.amountCents)),
      discountCents: sumOf(discounts.map((d) => d.amountCents)),
      taxes,
      fees,
      discounts,
      lineItems,
      gstin,
      category,
      confidence: r.confidence,
      notes: cleanText(r.notes, 300),
    },
    warnings,
    warningFields: [...fields],
    recheck,
  };
}

// --------------------------------------------------------- partial streaming

/**
 * Fields worth showing while the JSON is still arriving: only finished
 * values, and only plausible ones (a half-read date or unknown code waits).
 */
export function partialFields(parsed: unknown): PartialFields | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const out: PartialFields = {};
  if (typeof p.merchant === 'string') out.merchant = cleanText(p.merchant, 200);
  if (typeof p.date === 'string' && isCalendarDate(p.date)) out.date = p.date;
  const currency = typeof p.currency === 'string' ? cleanCurrency(p.currency) : null;
  if (currency) out.currency = currency;
  if (Array.isArray(p.line_items)) {
    const items: { name: string; amountCents: number }[] = [];
    for (const it of p.line_items) {
      if (isPartial(it) || it === null || typeof it !== 'object') continue;
      const { name, amount_minor } = it as Record<string, unknown>;
      const clean = typeof name === 'string' ? cleanText(name, 120) : null;
      if (clean && typeof amount_minor === 'number' && part(amount_minor) !== null) {
        items.push({ name: clean, amountCents: amount_minor });
      }
    }
    if (items.length > 0) out.lineItems = items.slice(0, MAX_ITEMS);
  }
  if (typeof p.total_minor === 'number' && part(p.total_minor) !== null && p.total_minor > 0) {
    const digits = currencyDigits(currency ?? 'USD');
    const printed =
      typeof p.total_raw === 'string' ? parsePrintedAmount(p.total_raw, digits) : null;
    out.totalCents = printed !== null && printed > 0 ? printed : p.total_minor;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse the -o file's contents (the model's final message). */
export function parseModelOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate a fenced block if a model ever wraps its JSON.
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) throw new Error('model output is not JSON');
    return JSON.parse(m[0]);
  }
}
