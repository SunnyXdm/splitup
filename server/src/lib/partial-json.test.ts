import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPartial, parsePartialJson } from './partial-json';

describe('parsePartialJson', () => {
  it('parses complete JSON like JSON.parse', () => {
    const doc = { a: 1, b: [true, null, 'x\n"y"'], c: { d: -2.5e3, e: 'éé' } };
    assert.deepEqual(parsePartialJson(JSON.stringify(doc)), doc);
    assert.deepEqual(parsePartialJson(JSON.stringify(doc, null, 2)), doc);
  });

  it('drops a string or number that may still grow', () => {
    assert.deepEqual(parsePartialJson('{"merchant":"Chaa'), {});
    assert.deepEqual(parsePartialJson('{"merchant":"Chaayos","total":66'), { merchant: 'Chaayos' });
    assert.deepEqual(parsePartialJson('{"merchant":"Chaayos","total":660,'), {
      merchant: 'Chaayos',
      total: 660,
    });
    assert.deepEqual(parsePartialJson('{"a":tr'), {});
    assert.deepEqual(parsePartialJson('{"a":true'), { a: true });
    assert.deepEqual(parsePartialJson('{"a":"x\\'), {});
    assert.deepEqual(parsePartialJson('{"a":"\\u00e'), {});
  });

  it('drops a key without its value', () => {
    assert.deepEqual(parsePartialJson('{"a":1,"b'), { a: 1 });
    assert.deepEqual(parsePartialJson('{"a":1,"b":'), { a: 1 });
  });

  it('keeps finished array elements and marks the one still streaming', () => {
    const v = parsePartialJson('{"items":[{"name":"Chai","amount":240},{"name":"Po') as {
      items: Record<string, unknown>[];
    };
    assert.equal(v.items.length, 2);
    assert.equal(isPartial(v.items[0]), false);
    assert.equal(isPartial(v.items[1]), true);
    assert.deepEqual(v.items[1], {});
  });

  it('returns undefined for nothing parseable yet', () => {
    assert.equal(parsePartialJson(''), undefined);
    assert.equal(parsePartialJson('   '), undefined);
    assert.deepEqual(parsePartialJson('{'), {});
    assert.deepEqual(parsePartialJson('['), []);
  });

  it('throws on text that is not JSON at all', () => {
    assert.throws(() => parsePartialJson('{"a" 1}'));
    assert.throws(() => parsePartialJson('hello'));
  });
});
