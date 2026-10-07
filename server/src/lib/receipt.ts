/**
 * Pure helpers for receipt scanning: the strict output schema handed to the
 * model, input image validation, and normalization of the model's answer into
 * a draft the client can prefill. No I/O here — see ../receipts.ts.
 */
import { z } from 'zod';
import { CATEGORIES, MAX_CENTS } from '../validate';

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
      return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
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

const nullableInt = { type: ['integer', 'null'] } as const;

/**
 * JSON Schema for `codex exec --output-schema`. Strict structured outputs need
 * every property in `required` and additionalProperties:false at each level;
 * optional data is expressed as a nullable type instead.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'merchant',
    'date',
    'currency',
    'total_minor',
    'subtotal_minor',
    'tax_minor',
    'tip_minor',
    'discount_minor',
    'line_items',
    'category',
    'confidence',
    'notes',
  ],
  properties: {
    merchant: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    currency: { type: ['string', 'null'], description: 'ISO 4217 code, e.g. INR' },
    total_minor: nullableInt,
    subtotal_minor: nullableInt,
    tax_minor: nullableInt,
    tip_minor: nullableInt,
    discount_minor: nullableInt,
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'quantity', 'amount_minor'],
        properties: {
          name: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          amount_minor: { type: 'integer' },
        },
      },
    },
    category: { type: 'string', enum: [...CATEGORIES] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: ['string', 'null'] },
  },
} as const;

export const RECEIPT_PROMPT = [
  'Extract the data from the attached receipt image into the required JSON.',
  'Rules:',
  '- Report only what is visibly printed on the receipt. Never guess or invent values; use null when a field is missing or unreadable.',
  '- All *_minor amounts are integers in the minor units of the receipt currency (e.g. INR/USD/EUR: 12.50 -> 1250; JPY has no minor unit: 1200 -> 1200).',
  '- total_minor is the final amount payable (grand total after tax, service charge, tip and discounts).',
  '- discount_minor is a positive number for the total discount; tax_minor is the sum of all taxes (GST/VAT/CGST+SGST etc.); service charge counts as tip_minor.',
  '- line_items: each purchased item with its line amount (quantity x unit price) as printed; quantity null if not shown. Skip tax, tip and total lines.',
  '- currency: ISO 4217 code inferred from symbols/text on the receipt (₹/Rs -> INR); null if there is no indication.',
  '- date: the transaction date as YYYY-MM-DD; null if absent or ambiguous.',
  `- category: the best fit among ${CATEGORIES.join(', ')}.`,
  '- confidence: low if the image is blurry, cropped, or not a receipt; medium if some values were hard to read.',
  '- notes: a short remark only if something important is unclear (e.g. "total partially cut off"); otherwise null.',
  'Do not run any commands; just read the image and answer.',
].join('\n');

const rawItem = z.object({
  name: z.string(),
  quantity: z.number().nullable(),
  amount_minor: z.number().int(),
});

const nullableMinor = z.number().int().nullable();

/** What the model must have produced (shape only; values are vetted below). */
export const rawReceiptSchema = z.object({
  merchant: z.string().nullable(),
  date: z.string().nullable(),
  currency: z.string().nullable(),
  total_minor: nullableMinor,
  subtotal_minor: nullableMinor,
  tax_minor: nullableMinor,
  tip_minor: nullableMinor,
  discount_minor: nullableMinor,
  line_items: z.array(rawItem),
  category: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string().nullable(),
});
export type RawReceipt = z.infer<typeof rawReceiptSchema>;

// ------------------------------------------------------------- normalization

export interface ReceiptLineItem {
  name: string;
  quantity: number | null;
  amountCents: number;
}

/** Wire shape returned to the client (mirrors web/src/lib/types.ts). */
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

const MAX_ITEMS = 100;
let currencySet: Set<string> | null = null;
function isKnownCurrency(code: string): boolean {
  currencySet ??= new Set(Intl.supportedValuesOf('currency'));
  return currencySet.has(code);
}

function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

const cleanText = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  // Collapse whitespace/control chars so model output can't smuggle layout.
  const t = s.replace(/[\p{Cc}\s]+/gu, ' ').trim().slice(0, max);
  return t === '' ? null : t;
};

/** Non-negative, within the app's max; otherwise dropped. */
const part = (v: number | null): number | null =>
  v !== null && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS ? v : null;

/**
 * Vet the model's answer. Anything implausible is nulled out (never fails the
 * whole scan) and explained in `warnings`, so the user can still fix it up.
 * `today` (YYYY-MM-DD) is injectable for tests.
 */
export function normalizeReceipt(
  raw: unknown,
  today: string = new Date().toISOString().slice(0, 10),
): { draft: ReceiptDraft; warnings: string[] } {
  const r = rawReceiptSchema.parse(raw);
  const warnings: string[] = [];

  let currency = r.currency?.trim().toUpperCase() ?? null;
  if (currency !== null && !(/^[A-Z]{3}$/.test(currency) && isKnownCurrency(currency))) {
    warnings.push(`Unrecognized currency "${currency.slice(0, 8)}".`);
    currency = null;
  }

  let date = r.date?.trim() ?? null;
  if (date !== null && !isCalendarDate(date)) {
    warnings.push("Couldn't read the receipt date.");
    date = null;
  } else if (date !== null) {
    // Allow a day of slack for time zones; further out is a misread.
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (date > tomorrow) {
      warnings.push(`Receipt date ${date} is in the future — check it.`);
      date = null;
    } else if (date < '2000-01-01') {
      warnings.push(`Receipt date ${date} looks wrong — check it.`);
      date = null;
    }
  }

  let totalCents = r.total_minor;
  if (totalCents !== null && !(Number.isSafeInteger(totalCents) && totalCents > 0 && totalCents <= MAX_CENTS)) {
    warnings.push('The total on the receipt looks implausible.');
    totalCents = null;
  }
  if (totalCents === null && !warnings.some((w) => w.includes('total'))) {
    warnings.push("Couldn't find the total — enter the amount yourself.");
  }

  const lineItems: ReceiptLineItem[] = [];
  for (const it of r.line_items.slice(0, MAX_ITEMS)) {
    const name = cleanText(it.name, 120);
    if (name === null || part(it.amount_minor) === null) continue;
    const quantity =
      it.quantity !== null && Number.isFinite(it.quantity) && it.quantity > 0 && it.quantity < 10_000
        ? it.quantity
        : null;
    lineItems.push({ name, quantity, amountCents: it.amount_minor });
  }
  if (r.line_items.length > lineItems.length) {
    warnings.push('Some line items were unreadable and were skipped.');
  }

  const subtotalCents = part(r.subtotal_minor);
  const taxCents = part(r.tax_minor);
  const tipCents = part(r.tip_minor);
  const discountCents = part(r.discount_minor);

  // Cross-checks: report mismatches, never "fix" them.
  if (lineItems.length > 0) {
    const itemsSum = lineItems.reduce((s, it) => s + it.amountCents, 0);
    if (subtotalCents !== null) {
      if (itemsSum !== subtotalCents) {
        warnings.push("The line items don't add up to the subtotal.");
      }
    } else if (totalCents !== null) {
      const expected = itemsSum + (taxCents ?? 0) + (tipCents ?? 0) - (discountCents ?? 0);
      if (expected !== totalCents) {
        warnings.push("The line items, tax and tip don't add up to the total.");
      }
    }
  }
  if (subtotalCents !== null && totalCents !== null) {
    const expected = subtotalCents + (taxCents ?? 0) + (tipCents ?? 0) - (discountCents ?? 0);
    // Rounding lines ("round off ±0.40") are common; allow < 1 major unit.
    if (Math.abs(expected - totalCents) >= 100) {
      warnings.push("Subtotal, tax and tip don't add up to the total.");
    }
  }

  const category = (CATEGORIES as readonly string[]).includes(r.category)
    ? (r.category as Category)
    : 'general';

  return {
    draft: {
      merchant: cleanText(r.merchant, 200),
      date,
      currency,
      totalCents,
      subtotalCents,
      taxCents,
      tipCents,
      discountCents,
      lineItems,
      category,
      confidence: r.confidence,
      notes: cleanText(r.notes, 300),
    },
    warnings,
  };
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
