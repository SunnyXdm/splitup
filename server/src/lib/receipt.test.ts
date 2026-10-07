import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_IMAGE_BYTES,
  RECEIPT_JSON_SCHEMA,
  decodeImageDataUrl,
  normalizeReceipt,
  parseModelOutput,
  type RawReceipt,
} from './receipt';

const base = (over: Partial<RawReceipt> = {}): RawReceipt => ({
  merchant: 'Chaayos',
  date: '2026-10-01',
  currency: 'INR',
  total_minor: 66000,
  subtotal_minor: null,
  tax_minor: null,
  tip_minor: null,
  discount_minor: null,
  line_items: [
    { name: 'Masala chai', quantity: 2, amount_minor: 24000 },
    { name: 'Bun maska', quantity: 3, amount_minor: 42000 },
  ],
  category: 'food',
  confidence: 'high',
  notes: null,
  ...over,
});
const TODAY = '2026-10-07';

describe('normalizeReceipt', () => {
  it('passes a consistent receipt through with no warnings', () => {
    const { draft, warnings } = normalizeReceipt(base(), TODAY);
    assert.deepEqual(warnings, []);
    assert.equal(draft.totalCents, 66000);
    assert.equal(draft.currency, 'INR');
    assert.equal(draft.category, 'food');
    assert.equal(draft.lineItems.length, 2);
    assert.deepEqual(draft.lineItems[0], { name: 'Masala chai', quantity: 2, amountCents: 24000 });
  });

  it('warns when line items do not add up', () => {
    const { warnings } = normalizeReceipt(base({ total_minor: 70000 }), TODAY);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /add up to the total/);
  });

  it('accounts for tax, tip and discount when no subtotal is printed', () => {
    const { warnings } = normalizeReceipt(
      base({ total_minor: 66000 + 3300 + 1000 - 500, tax_minor: 3300, tip_minor: 1000, discount_minor: 500 }),
      TODAY,
    );
    assert.deepEqual(warnings, []);
  });

  it('checks items against the subtotal and subtotal+tax against the total', () => {
    const ok = normalizeReceipt(base({ subtotal_minor: 66000, tax_minor: 3300, total_minor: 69300 }), TODAY);
    assert.deepEqual(ok.warnings, []);
    // A round-off line under one major unit is tolerated.
    const rounded = normalizeReceipt(base({ subtotal_minor: 66000, tax_minor: 3340, total_minor: 69300 }), TODAY);
    assert.deepEqual(rounded.warnings, []);
    const bad = normalizeReceipt(base({ subtotal_minor: 60000, tax_minor: 3300, total_minor: 90000 }), TODAY);
    assert.equal(bad.warnings.length, 2);
  });

  it('nulls an implausible total instead of failing', () => {
    for (const total of [0, -5, 100_000_001]) {
      const { draft, warnings } = normalizeReceipt(base({ total_minor: total, line_items: [] }), TODAY);
      assert.equal(draft.totalCents, null);
      assert.match(warnings.join(' '), /total/i);
    }
  });

  it('asks the user to enter the amount when no total was found', () => {
    const { draft, warnings } = normalizeReceipt(base({ total_minor: null, line_items: [] }), TODAY);
    assert.equal(draft.totalCents, null);
    assert.match(warnings[0]!, /enter the amount/);
  });

  it('rejects bad or future dates and unknown currencies', () => {
    const a = normalizeReceipt(base({ date: '2026-02-30', currency: 'XYZ' }), TODAY);
    assert.equal(a.draft.date, null);
    assert.equal(a.draft.currency, null);
    assert.equal(a.warnings.length, 2);
    const b = normalizeReceipt(base({ date: '2027-01-01' }), TODAY);
    assert.equal(b.draft.date, null);
    assert.match(b.warnings[0]!, /future/);
    // Tomorrow is allowed (time zones).
    assert.equal(normalizeReceipt(base({ date: '2026-10-08' }), TODAY).draft.date, '2026-10-08');
    assert.equal(normalizeReceipt(base({ currency: ' usd ' }), TODAY).draft.currency, 'USD');
  });

  it('falls back to general for an unknown category and cleans text', () => {
    const { draft } = normalizeReceipt(
      base({ category: 'snacks', merchant: '  Chaayos\n\tCafe  ', notes: '   ' }),
      TODAY,
    );
    assert.equal(draft.category, 'general');
    assert.equal(draft.merchant, 'Chaayos Cafe');
    assert.equal(draft.notes, null);
  });

  it('skips unreadable line items with a warning', () => {
    const { draft, warnings } = normalizeReceipt(
      base({
        total_minor: 24000,
        line_items: [
          { name: 'Masala chai', quantity: 2, amount_minor: 24000 },
          { name: '', quantity: null, amount_minor: 100 },
          { name: 'Refund?', quantity: -1, amount_minor: -500 },
        ],
      }),
      TODAY,
    );
    assert.equal(draft.lineItems.length, 1);
    assert.match(warnings.join(' '), /skipped/);
  });

  it('throws on output that does not match the schema shape', () => {
    assert.throws(() => normalizeReceipt({ merchant: 'x' }, TODAY));
    assert.throws(() => normalizeReceipt(base({ total_minor: 12.5 }), TODAY));
  });
});

describe('parseModelOutput', () => {
  it('parses plain and fenced JSON', () => {
    assert.deepEqual(parseModelOutput('{"a":1}\n'), { a: 1 });
    assert.deepEqual(parseModelOutput('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => parseModelOutput('no json here'));
  });
});

describe('decodeImageDataUrl', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

  it('accepts matching JPEG, PNG and WebP', () => {
    for (const [mime, b] of [
      ['image/jpeg', jpeg],
      ['image/png', png],
      ['image/webp', webp],
    ] as const) {
      const r = decodeImageDataUrl(url(mime, b));
      assert.ok(!('error' in r), mime);
      assert.equal(r.mime, mime);
    }
  });

  it('rejects mismatched magic bytes, other types and junk', () => {
    assert.ok('error' in decodeImageDataUrl(url('image/png', jpeg)));
    assert.ok('error' in decodeImageDataUrl(url('image/gif', Buffer.from('GIF89a'))));
    assert.ok('error' in decodeImageDataUrl('data:image/jpeg;base64,'));
    assert.ok('error' in decodeImageDataUrl('not a data url'));
  });

  it('rejects oversized images', () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 10);
    jpeg.copy(big);
    const r = decodeImageDataUrl(url('image/jpeg', big));
    assert.deepEqual(r, { error: 'image too large' });
  });
});

describe('RECEIPT_JSON_SCHEMA', () => {
  it('requires every property at each level (strict structured outputs)', () => {
    assert.deepEqual(
      [...RECEIPT_JSON_SCHEMA.required].sort(),
      Object.keys(RECEIPT_JSON_SCHEMA.properties).sort(),
    );
    const item = RECEIPT_JSON_SCHEMA.properties.line_items.items;
    assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
  });
});
