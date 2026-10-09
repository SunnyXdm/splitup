import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkReceipt,
  gstinCheckChar,
  isAmbiguousNumericDate,
  isGroupedNumber,
  isValidGstin,
  parsePrintedAmount,
  rawDateMatches,
  type CheckInput,
} from './receipt-checks';

describe('GSTIN checksum', () => {
  it('accepts real GSTINs', () => {
    for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '33AAACH7409R1Z8', '24AAACC1206D1ZM']) {
      assert.ok(isValidGstin(g), g);
    }
    assert.ok(isValidGstin(' 27aapfu0939f1zv '), 'case and spacing are forgiven');
  });

  it('rejects a wrong check character, a misread digit and bad shapes', () => {
    assert.equal(isValidGstin('27AAPFU0939F1ZW'), false);
    assert.equal(isValidGstin('27AAPFU0989F1ZV'), false);
    assert.equal(isValidGstin('07AAJCS1234F1Z5'), false);
    assert.equal(isValidGstin('27AAPFU0939F1Z'), false);
    assert.equal(isValidGstin('00AAPFU0939F1ZV'), false, 'state code 00');
    assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
    assert.equal(gstinCheckChar('short'), null);
  });
});

describe('parsePrintedAmount', () => {
  const cases: [string, number, number | null][] = [
    ['Rs. 1,23,456.50', 2, 12345650],
    ['₹660.00', 2, 66000],
    ['Rs 660', 2, 66000],
    ['780/-', 2, 78000],
    ['LKR 1,250.00', 2, 125000],
    ['1,00,00,000', 2, 1000000000],
    ['1.234,50', 2, 123450],
    ['12,345', 2, 1234500],
    ['1,234', 0, 1234],
    ['1.250', 3, 1250],
    ['12.5', 2, 1250],
    ['12,50', 2, 1250],
    ['(15.00)', 2, -1500],
    ['-0.40', 2, -40],
    ['abc', 2, null],
    ['1,2,3', 2, null],
    ['', 2, null],
  ];
  for (const [raw, digits, want] of cases) {
    it(`${JSON.stringify(raw)} (${digits} digits) → ${want}`, () => {
      assert.equal(parsePrintedAmount(raw, digits), want);
    });
  }

  it('recognises western and Indian digit grouping', () => {
    assert.ok(isGroupedNumber('1,234,567', ','));
    assert.ok(isGroupedNumber('12,34,567', ','));
    assert.ok(isGroupedNumber('1.234.567', '.'));
    assert.equal(isGroupedNumber('1,23,45', ','), false);
    assert.equal(isGroupedNumber('1234,567', ','), false);
  });
});

describe('dates', () => {
  it('matches a printed date in either day/month order', () => {
    assert.ok(rawDateMatches('03/10/2026', '2026-10-03'));
    assert.ok(rawDateMatches('10/03/26', '2026-10-03'));
    assert.ok(rawDateMatches('3 Oct 2026 18:42', '2026-10-03'));
    assert.equal(rawDateMatches('03/10/2026', '2026-10-04'), false);
  });

  it('knows when a numeric date is ambiguous', () => {
    assert.ok(isAmbiguousNumericDate('03/10/2026'));
    assert.equal(isAmbiguousNumericDate('13/10/2026'), false);
    assert.equal(isAmbiguousNumericDate('10/10/2026'), false);
  });
});

describe('checkReceipt', () => {
  const base = (over: Partial<CheckInput> = {}): CheckInput => ({
    digits: 2,
    totalCents: 66000,
    subtotalCents: 62857,
    itemCents: [24000, 12000, 15000, 11857],
    taxes: [
      { kind: 'CGST', ratePercent: 2.5, amountCents: 1571, inclusive: false },
      { kind: 'SGST', ratePercent: 2.5, amountCents: 1572, inclusive: false },
    ],
    feeCents: [],
    discountCents: [],
    gstin: null,
    date: '2026-10-03',
    dateRaw: '03/10/2026',
    today: '2026-10-09',
    ...over,
  });
  const fields = (over: Partial<CheckInput>) => checkReceipt(base(over)).map((i) => i.field);

  it('passes the Chaayos bill', () => {
    assert.deepEqual(checkReceipt(base()), []);
  });

  it('allows unprinted rounding of up to one unit', () => {
    assert.deepEqual(fields({ totalCents: 66043 }), []);
    assert.deepEqual(fields({ totalCents: 66200 }), ['total']);
  });

  it('checks items against the subtotal', () => {
    assert.deepEqual(fields({ subtotalCents: 60000, totalCents: 63143 }), ['line_items']);
  });

  it('checks each tax against its rate', () => {
    const bad = checkReceipt(
      base({
        taxes: [
          { kind: 'CGST', ratePercent: 9, amountCents: 1571, inclusive: false },
          { kind: 'SGST', ratePercent: 9, amountCents: 1571, inclusive: false },
        ],
        totalCents: 65999,
      }),
    );
    assert.equal(bad.filter((i) => i.field === 'taxes').length, 2);
  });

  it('wants CGST equal to SGST, and IGST alone', () => {
    assert.deepEqual(
      fields({
        taxes: [
          { kind: 'CGST', ratePercent: null, amountCents: 1571, inclusive: false },
          { kind: 'SGST', ratePercent: null, amountCents: 2000, inclusive: false },
        ],
        totalCents: 66428,
      }),
      ['taxes'],
    );
    assert.deepEqual(
      fields({
        taxes: [
          { kind: 'IGST', ratePercent: 5, amountCents: 3143, inclusive: false },
          { kind: 'CGST', ratePercent: null, amountCents: 1, inclusive: false },
          { kind: 'SGST', ratePercent: null, amountCents: 1, inclusive: false },
        ],
        totalCents: 66002,
      }),
      ['taxes'],
    );
    assert.deepEqual(
      fields({ taxes: [{ kind: 'IGST', ratePercent: 5, amountCents: 3143, inclusive: false }] }),
      [],
    );
  });

  it('handles VAT-inclusive Sri Lankan bills', () => {
    assert.deepEqual(
      fields({
        subtotalCents: null,
        itemCents: [45000, 33000],
        taxes: [{ kind: 'VAT', ratePercent: 18, amountCents: 11898, inclusive: true }],
        totalCents: 78000,
        date: '2026-10-05',
        dateRaw: '05.10.2026',
      }),
      [],
    );
  });

  it('accepts a discount printed before or after the subtotal', () => {
    const items = [24000, 12000, 15000, 11857]; // 628.57
    const taxes = [
      { kind: 'CGST' as const, ratePercent: 2.5, amountCents: 1500, inclusive: false },
      { kind: 'SGST' as const, ratePercent: 2.5, amountCents: 1500, inclusive: false },
    ];
    // Subtotal before the discount: 628.57 − 28.57 + 30.00 = 630.00
    assert.deepEqual(
      fields({
        itemCents: items,
        subtotalCents: 62857,
        discountCents: [2857],
        taxes,
        totalCents: 63000,
      }),
      [],
    );
    // Subtotal already net of the discount.
    assert.deepEqual(
      fields({
        itemCents: items,
        subtotalCents: 60000,
        discountCents: [2857],
        taxes,
        totalCents: 63000,
      }),
      [],
    );
  });

  it('checks the GSTIN and the date', () => {
    assert.deepEqual(fields({ gstin: '27AAPFU0939F1ZV' }), []);
    assert.deepEqual(fields({ gstin: '27AAPFU0939F1ZX' }), ['gstin']);
    assert.deepEqual(fields({ date: '2026-12-01', dateRaw: '01/12/2026' }), ['date']);
    assert.deepEqual(fields({ date: '1999-12-31', dateRaw: '31/12/1999' }), ['date']);
    assert.deepEqual(fields({ date: '2026-10-04' }), ['date'], 'not the printed date');
  });
});
