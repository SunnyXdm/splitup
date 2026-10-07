import { describe, expect, it } from 'vitest';
import { parsePercentInput, parseShareInput } from './money-input';

describe('parseShareInput', () => {
  it('accepts comma decimals instead of multiplying by 100', () => {
    expect(parseShareInput('12,50', 'EUR', 'en-US')).toBe(1250);
    expect(parseShareInput('12,50', 'EUR', 'de-DE')).toBe(1250);
    expect(parseShareInput('1.234,5', 'EUR', 'de-DE')).toBe(123450);
  });

  it('treats empty as zero and rejects ambiguous text', () => {
    expect(parseShareInput('', 'EUR')).toBe(0);
    expect(parseShareInput('  ', 'EUR')).toBe(0);
    expect(parseShareInput('1,2345', 'USD', 'en-US')).toBeNull();
    expect(parseShareInput('abc', 'USD')).toBeNull();
  });
});

describe('parsePercentInput', () => {
  it('parses comma-decimal percents to basis points', () => {
    expect(parsePercentInput('33,33', 'de-DE')).toBe(3333);
    expect(parsePercentInput('33,33', 'en-US')).toBe(3333);
    expect(parsePercentInput('50')).toBe(5000);
    expect(parsePercentInput('100,01', 'de-DE')).toBeNull();
  });
});
