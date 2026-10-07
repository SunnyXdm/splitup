import { describe, expect, it } from 'vitest';
import { activitySummary, curlyQuotes, displayName, properName, shortName } from './names';

describe('shortName', () => {
  it('takes the first name', () => {
    expect(shortName({ name: 'Darshna Gupta' })).toBe('Darshna');
    expect(shortName('  Karthik Subramanian Venkataraman ')).toBe('Karthik');
  });
  it('title-cases ALL CAPS names only', () => {
    expect(shortName({ name: 'PRIYA DUGGAL' })).toBe('Priya');
    expect(shortName({ name: 'McKenzie Jones' })).toBe('McKenzie');
    expect(shortName({ name: 'JO-ANNE SMITH' })).toBe('Jo-Anne');
  });
  it('handles empty names', () => {
    expect(shortName({ name: '  ' })).toBe('Someone');
  });
});

describe('properName', () => {
  it('title-cases shouted words and keeps the rest', () => {
    expect(properName('PRIYA DUGGAL')).toBe('Priya Duggal');
    expect(properName('Ana de la Cruz')).toBe('Ana de la Cruz');
  });
});

describe('displayName', () => {
  const me = { id: 1, name: 'Sunny' };
  const priya = { id: 2, name: 'PRIYA DUGGAL' };
  it('says You/you for me by case', () => {
    expect(displayName(me, 1)).toBe('You');
    expect(displayName(me, 1, { case: 'object' })).toBe('you');
  });
  it('uses the name for others, short on request', () => {
    expect(displayName(priya, 1)).toBe('PRIYA DUGGAL');
    expect(displayName(priya, 1, { short: true })).toBe('Priya');
  });
  it('falls back to someone', () => {
    expect(displayName(undefined, 1)).toBe('Someone');
    expect(displayName(undefined, 1, { case: 'object' })).toBe('someone');
  });
});

describe('activitySummary', () => {
  const me = { name: 'Sunny' };
  it('puts me first as You, with curly quotes', () => {
    expect(activitySummary("Sunny added 'Swiggy' in Flat 4B", me)).toBe(
      'You added ‘Swiggy’ in Flat 4B',
    );
  });
  it('uses you in object position', () => {
    expect(activitySummary('PRIYA DUGGAL settled up with Sunny (₹8,380.00)', me)).toBe(
      'PRIYA DUGGAL settled up with you (₹8,380.00)',
    );
  });
  it("leaves other people's rows and apostrophes alone", () => {
    expect(activitySummary("Sunnyvale's trip was added by Ravi", me)).toBe(
      "Sunnyvale's trip was added by Ravi",
    );
    expect(curlyQuotes("Ravi's 'Chai & samosa'")).toBe("Ravi's ‘Chai & samosa’");
  });
});
