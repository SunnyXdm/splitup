import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_IMAGE_BYTES,
  RECEIPT_JSON_SCHEMA,
  decodeImageDataUrl,
  normalizeReceipt,
  parseModelOutput,
  partialFields,
  receiptUserPrompt,
  type RawReceipt,
} from './receipt';
import { parsePartialJson } from './partial-json';

const base = (over: Partial<RawReceipt> = {}): RawReceipt => ({
  merchant: 'Chaayos',
  location: 'Connaught Place, New Delhi',
  gstin: null,
  date_raw: '01/10/2026',
  date: '2026-10-01',
  currency_raw: 'Rs',
  currency: 'INR',
  line_items: [
    { raw_text: '2 x Masala chai 240.00', name: 'Masala chai', quantity: 2, amount_minor: 24000 },
    { raw_text: '3 x Bun maska 420.00', name: 'Bun maska', quantity: 3, amount_minor: 42000 },
  ],
  subtotal_minor: null,
  discounts: [],
  taxes: [],
  fees: [],
  total_raw: 'Rs 660.00',
  total_minor: 66000,
  category: 'food',
  confidence: 'high',
  illegible_fields: [],
  uncertain_fields: [],
  notes: null,
  ...over,
});
const TODAY = '2026-10-07';
const gst = (kind: 'CGST' | 'SGST' | 'IGST', amount: number, rate = 2.5) => ({
  kind,
  label: `${kind} ${rate}%`,
  rate_percent: rate,
  amount_minor: amount,
  inclusive: false,
});

describe('normalizeReceipt', () => {
  it('passes a consistent receipt through with no warnings', () => {
    const { draft, warnings, recheck } = normalizeReceipt(base(), TODAY);
    assert.deepEqual(warnings, []);
    assert.deepEqual(recheck, []);
    assert.equal(draft.totalCents, 66000);
    assert.equal(draft.currency, 'INR');
    assert.equal(draft.currencyRaw, 'Rs');
    assert.equal(draft.dateRaw, '01/10/2026');
    assert.equal(draft.category, 'food');
    assert.equal(draft.lineItems.length, 2);
    assert.deepEqual(draft.lineItems[0], { name: 'Masala chai', quantity: 2, amountCents: 24000 });
  });

  it('reconciles a GST bill (Chaayos: subtotal 628.57 + CGST 15.71 + SGST 15.72)', () => {
    const { draft, warnings } = normalizeReceipt(
      base({
        line_items: [
          { raw_text: '', name: 'Masala Chai', quantity: 2, amount_minor: 24000 },
          { raw_text: '', name: 'Bun Maska', quantity: 1, amount_minor: 12000 },
          { raw_text: '', name: 'Poha', quantity: 1, amount_minor: 15000 },
          { raw_text: '', name: 'Vada Pav', quantity: 1, amount_minor: 11857 },
        ],
        subtotal_minor: 62857,
        taxes: [gst('CGST', 1571), gst('SGST', 1572)],
        gstin: '27AAPFU0939F1ZV',
      }),
      TODAY,
    );
    assert.deepEqual(warnings, []);
    assert.equal(draft.taxCents, 3143);
    assert.equal(draft.taxes.length, 2);
    assert.equal(draft.gstin, '27AAPFU0939F1ZV');
  });

  it('flags a total that does not add up and asks for a re-check', () => {
    const { warnings, warningFields, recheck } = normalizeReceipt(
      base({ total_minor: 70000, total_raw: '700.00' }),
      TODAY,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /add up to the total/);
    assert.deepEqual(warningFields, ['total']);
    assert.equal(recheck.length, 1);
  });

  it('accounts for taxes, fees, round-off and discounts', () => {
    const { warnings } = normalizeReceipt(
      base({
        taxes: [gst('CGST', 1650), gst('SGST', 1650)],
        fees: [
          { kind: 'SERVICE_CHARGE', label: 'Service charge', amount_minor: 1000 },
          { kind: 'ROUND_OFF', label: 'Round off', amount_minor: -50 },
        ],
        discounts: [{ label: 'Member', amount_minor: 500 }],
        total_minor: 66000 + 3300 + 1000 - 50 - 500,
        total_raw: '697.50',
      }),
      TODAY,
    );
    assert.deepEqual(warnings, []);
  });

  it('treats VAT-inclusive prices as already in the items', () => {
    const { warnings, draft } = normalizeReceipt(
      base({
        currency: 'LKR',
        taxes: [
          {
            kind: 'VAT',
            label: 'VAT 18% incl.',
            rate_percent: 18,
            amount_minor: 10068,
            inclusive: true,
          },
        ],
      }),
      TODAY,
    );
    assert.deepEqual(warnings, []);
    assert.equal(draft.taxCents, null);
    assert.equal(draft.currency, 'LKR');
  });

  it('prefers the printed total when the model mis-scaled minor units', () => {
    const { draft, recheck } = normalizeReceipt(
      base({ total_minor: 660, total_raw: 'Rs. 660.00' }),
      TODAY,
    );
    assert.equal(draft.totalCents, 66000);
    assert.match(recheck.join(' '), /disagrees/);
  });

  it('parses Indian digit grouping in the printed total', () => {
    const { draft } = normalizeReceipt(
      base({
        line_items: [],
        total_minor: 12345650,
        total_raw: '₹ 1,23,456.50',
      }),
      TODAY,
    );
    assert.equal(draft.totalCents, 12345650);
  });

  it('warns on CGST without SGST and on IGST mixed with CGST/SGST', () => {
    const lone = normalizeReceipt(
      base({ taxes: [gst('CGST', 1650)], total_minor: 67650, total_raw: '676.50' }),
      TODAY,
    );
    assert.match(lone.warnings.join(' '), /CGST without/);
    const mixed = normalizeReceipt(
      base({
        taxes: [gst('IGST', 3300, 5), gst('CGST', 1650), gst('SGST', 1650)],
        total_minor: 72600,
        total_raw: '726.00',
      }),
      TODAY,
    );
    assert.match(mixed.warnings.join(' '), /IGST appears together/);
  });

  it('warns about a bad GSTIN without escalating', () => {
    const { warnings, recheck, warningFields } = normalizeReceipt(
      base({ gstin: '07AAJCS1234F1Z5' }),
      TODAY,
    );
    assert.match(warnings[0]!, /GSTIN/);
    assert.deepEqual(warningFields, ['gstin']);
    assert.deepEqual(recheck, []);
  });

  it('nulls an implausible total instead of failing', () => {
    for (const total of [0, -5, 100_000_001]) {
      const { draft, warnings } = normalizeReceipt(
        base({ total_minor: total, total_raw: null, line_items: [] }),
        TODAY,
      );
      assert.equal(draft.totalCents, null);
      assert.match(warnings.join(' '), /total/i);
    }
  });

  it('asks the user to enter the amount when no total was found', () => {
    const { draft, warnings, recheck } = normalizeReceipt(
      base({ total_minor: null, total_raw: null, line_items: [] }),
      TODAY,
    );
    assert.equal(draft.totalCents, null);
    assert.match(warnings[0]!, /enter the amount/);
    assert.equal(recheck.length, 1);
  });

  it('rejects bad or future dates and unknown currencies', () => {
    const a = normalizeReceipt(base({ date: '2026-02-30', currency: 'XYZ' }), TODAY);
    assert.equal(a.draft.date, null);
    assert.equal(a.draft.currency, null);
    assert.equal(a.warnings.length, 2);
    const b = normalizeReceipt(base({ date: '2027-01-01', date_raw: '01/01/2027' }), TODAY);
    assert.equal(b.draft.date, null);
    assert.match(b.warnings[0]!, /future/);
    // Tomorrow is allowed (time zones).
    assert.equal(
      normalizeReceipt(base({ date: '2026-10-08', date_raw: '08-10-2026' }), TODAY).draft.date,
      '2026-10-08',
    );
    assert.equal(normalizeReceipt(base({ currency: ' usd ' }), TODAY).draft.currency, 'USD');
    // Any real ISO 4217 code works now, not just the old ten.
    assert.equal(normalizeReceipt(base({ currency: 'LKR' }), TODAY).draft.currency, 'LKR');
  });

  it('flags a date that is not what the receipt prints', () => {
    const { warnings } = normalizeReceipt(
      base({ date: '2026-10-05', date_raw: '01/10/2026' }),
      TODAY,
    );
    assert.match(warnings.join(' '), /doesn't match/);
  });

  it('escalation reasons cover low confidence and an illegible total', () => {
    const { recheck } = normalizeReceipt(
      base({ confidence: 'low', illegible_fields: ['total', 'nonsense'] }),
      TODAY,
    );
    assert.equal(recheck.length, 2);
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
        total_raw: '240.00',
        line_items: [
          { raw_text: '', name: 'Masala chai', quantity: 2, amount_minor: 24000 },
          { raw_text: '', name: '', quantity: null, amount_minor: 100 },
          { raw_text: '', name: 'Refund?', quantity: -1, amount_minor: -500 },
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

describe('partialFields', () => {
  it('keeps only finished, plausible values', () => {
    const json = JSON.stringify(base());
    const cut = json.slice(0, json.indexOf('Bun maska'));
    const f = partialFields(parsePartialJson(cut));
    assert.deepEqual(f, {
      merchant: 'Chaayos',
      date: '2026-10-01',
      currency: 'INR',
      lineItems: [{ name: 'Masala chai', amountCents: 24000 }],
    });
    assert.equal(partialFields(parsePartialJson(json))!.totalCents, 66000);
    assert.equal(partialFields(parsePartialJson('{"merchant":"Cha')), null);
    assert.equal(partialFields(parsePartialJson('{"date":"2026-1')), null);
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
    for (const key of ['line_items', 'discounts', 'taxes', 'fees'] as const) {
      const item = RECEIPT_JSON_SCHEMA.properties[key].items;
      assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort(), key);
      assert.equal(item.additionalProperties, false);
    }
  });

  it('stays within Claude strict-schema limits (≤16 nullable/union params)', () => {
    let unions = 0;
    const walk = (node: unknown) => {
      if (node === null || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (Array.isArray(n.type) || n.anyOf) unions += 1;
      for (const v of Object.values(n)) walk(v);
    };
    walk(RECEIPT_JSON_SCHEMA);
    assert.ok(unions <= 16, `${unions} union-typed params`);
  });
});

describe('receiptUserPrompt', () => {
  it('passes currency/locale hints and re-check reasons', () => {
    const p = receiptUserPrompt(
      { formCurrency: 'LKR', defaultCurrency: 'INR', locale: 'en-LK', today: '2026-10-09' },
      ['The total does not add up.'],
    );
    assert.match(p, /added in LKR/);
    assert.match(p, /default currency is INR/);
    assert.match(p, /en-LK/);
    assert.match(p, /The total does not add up/);
  });
});
