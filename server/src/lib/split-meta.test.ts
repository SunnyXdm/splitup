import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveShares } from './recurrence';
import { owedFromSplitMeta, parseSplitMeta, splitMetaProblem } from './split-meta';
import { splitMetaFromIntent } from './recurring';

describe('split meta', () => {
  it('computes owed amounts like the web client', () => {
    assert.deepEqual(
      [...owedFromSplitMeta({ mode: 'equal', participants: [3, 1, 2] }, 1000)],
      [
        [1, 334],
        [2, 333],
        [3, 333],
      ],
    );
    // Largest remainder, ties by participant order.
    assert.deepEqual(
      [
        ...owedFromSplitMeta(
          { mode: 'shares', participants: [2, 1], values: { '1': 1, '2': 1 } },
          101,
        ),
      ],
      [
        [2, 51],
        [1, 50],
      ],
    );
  });

  it('flags mismatches against the shares', () => {
    const shares = [
      { userId: 1, owedCents: 500 },
      { userId: 2, owedCents: 500 },
    ];
    assert.equal(splitMetaProblem({ mode: 'equal', participants: [1, 2] }, 1000, shares), null);
    assert.match(
      splitMetaProblem({ mode: 'equal', participants: [1, 1] }, 1000, shares) ?? '',
      /duplicate/,
    );
    assert.match(
      splitMetaProblem(
        { mode: 'unequal', participants: [1, 2], values: { '1': 400, '2': 600 } },
        1000,
        shares,
      ) ?? '',
      /does not match/,
    );
    assert.match(
      splitMetaProblem(
        { mode: 'percent', participants: [1, 2], values: { '1': 5000, '2': 0 } },
        1000,
        shares,
      ) ?? '',
      /positive/,
    );
  });

  it('parses stored JSON defensively', () => {
    assert.equal(parseSplitMeta(null), undefined);
    assert.equal(parseSplitMeta('{oops'), undefined);
    assert.equal(parseSplitMeta('{"mode":"equal"}'), undefined);
    assert.deepEqual(parseSplitMeta('{"mode":"equal","participants":[1]}'), {
      mode: 'equal',
      participants: [1],
    });
  });

  it('derives a recurring bill’s split when it reproduces the shares', () => {
    const intent = {
      mode: 'percent' as const,
      participants: [1, 2],
      values: [
        { userId: 1, value: 2500 },
        { userId: 2, value: 7500 },
      ],
      payers: [{ userId: 1, cents: 1000 }],
    };
    const shares = resolveShares(intent, 1000);
    assert.deepEqual(splitMetaFromIntent(intent, 1000, shares), {
      mode: 'percent',
      participants: [1, 2],
      values: { '1': 2500, '2': 7500 },
    });
    // An exact template scaled to another amount no longer matches its values.
    const exact = { ...intent, mode: 'exact' as const, values: [{ userId: 2, value: 1000 }] };
    assert.equal(splitMetaFromIntent(exact, 2000, resolveShares(exact, 2000)), undefined);
    assert.deepEqual(splitMetaFromIntent(exact, 1000, resolveShares(exact, 1000)), {
      mode: 'unequal',
      participants: [2],
      values: { '2': 1000 },
    });
  });
});
