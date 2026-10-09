import { describe, expect, it } from 'vitest';
import { createSseParser } from './api';
import { orderedCurrencies } from '@/components/common/currency-options';
import { CURRENCIES, currencyDigits, isSupportedCurrency } from './money';
import { matchesQuery } from './picker-match';
import type { ScanEvent } from './types';

describe('createSseParser', () => {
  const frames = [
    'event: status\ndata: {"type":"status","stage":"reading"}\n\n',
    ': ping\n\n',
    'event: thinking\ndata: {"type":"thinking","text":"CGST and\\nSGST match"}\n\n',
    'event: result\ndata: {"type":"result","draft":{},"warnings":[]}\n\n',
  ].join('');

  it('parses frames however the bytes are split', () => {
    for (const size of [1, 3, 7, 40, frames.length]) {
      const got: ScanEvent[] = [];
      const feed = createSseParser((e) => got.push(e));
      for (let i = 0; i < frames.length; i += size) feed(frames.slice(i, i + size));
      expect(got.map((e) => e.type)).toEqual(['status', 'thinking', 'result']);
      expect(got[1]).toEqual({ type: 'thinking', text: 'CGST and\nSGST match' });
    }
  });

  it('accepts CRLF line endings and skips malformed frames', () => {
    const got: ScanEvent[] = [];
    const feed = createSseParser((e) => got.push(e));
    feed('data: not json\r\n\r\ndata:{"type":"status","stage":"checking"}\r\n\r\n');
    expect(got).toEqual([{ type: 'status', stage: 'checking' }]);
  });
});

describe('currencies', () => {
  it('lists every ISO currency the browser knows, with the right minor digits', () => {
    expect(CURRENCIES.length).toBeGreaterThan(100);
    for (const c of ['INR', 'LKR', 'USD', 'EUR', 'JPY', 'BHD', 'THB']) {
      expect(isSupportedCurrency(c)).toBe(true);
    }
    expect(isSupportedCurrency('XDR')).toBe(false);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('BHD')).toBe(3);
    expect(currencyDigits('LKR')).toBe(2);
  });

  it('orders the picker: preferred, then common, then A–Z, without duplicates', () => {
    const list = orderedCurrencies(['GBP', 'INR']);
    expect(list.slice(0, 4)).toEqual(['GBP', 'INR', 'LKR', 'USD']);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBe(CURRENCIES.length);
  });

  it('searches code, name and accents loosely', () => {
    const lkr = { value: 'LKR', label: 'LKR', sublabel: 'Sri Lankan Rupee' };
    expect(matchesQuery(lkr, 'lkr')).toBe(true);
    expect(matchesQuery(lkr, ' rupee ')).toBe(true);
    expect(matchesQuery(lkr, 'euro')).toBe(false);
    expect(
      matchesQuery({ value: 'CRC', label: 'CRC', sublabel: 'Costa Rican Colón' }, 'colon'),
    ).toBe(true);
  });
});
