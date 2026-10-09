import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickBetter, receiptConfig } from './receipts';
import type { NormalizedReceipt } from './lib/receipt';

describe('receiptConfig (provider selection)', () => {
  const KEY = { ANTHROPIC_API_KEY: 'sk-test' };

  it('prefers Claude when a key is set, else Codex, else off', () => {
    assert.equal(receiptConfig(KEY, true).provider, 'anthropic');
    assert.equal(receiptConfig({}, true).provider, 'codex');
    assert.equal(receiptConfig({}, false).provider, null);
    assert.equal(receiptConfig({ ANTHROPIC_API_KEY: '  ' }, false).provider, null);
  });

  it('honours RECEIPT_PROVIDER and RECEIPT_SCAN=0', () => {
    assert.equal(receiptConfig({ ...KEY, RECEIPT_PROVIDER: 'codex' }, true).provider, 'codex');
    assert.equal(receiptConfig({ ...KEY, RECEIPT_PROVIDER: 'codex' }, false).provider, null);
    assert.equal(receiptConfig({ RECEIPT_PROVIDER: 'anthropic' }, true).provider, null);
    assert.equal(receiptConfig({ ...KEY, RECEIPT_SCAN: '0' }, true).provider, null);
  });

  it('defaults to Sonnet 5.5 at low effort, escalating to Opus 5.5', () => {
    const c = receiptConfig(KEY, false);
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.equal(c.escalateModel, 'claude-opus-5-5');
    assert.equal(c.effort, 'low');
    assert.equal(c.codexModel, 'gpt-5.6-luna');
  });

  it('reads overrides; an empty escalate model disables escalation', () => {
    const c = receiptConfig(
      {
        ...KEY,
        RECEIPT_MODEL: 'claude-haiku-5-5',
        RECEIPT_ESCALATE_MODEL: '',
        RECEIPT_EFFORT: 'medium',
      },
      false,
    );
    assert.equal(c.model, 'claude-haiku-5-5');
    assert.equal(c.escalateModel, null);
    assert.equal(c.effort, 'medium');
    assert.equal(receiptConfig({ ...KEY, RECEIPT_EFFORT: 'bogus' }, false).effort, 'low');
    // Escalating to the same model is pointless.
    assert.equal(
      receiptConfig({ ...KEY, RECEIPT_MODEL: 'claude-opus-5-5' }, false).escalateModel,
      null,
    );
  });

  it('keeps a legacy RECEIPT_MODEL=gpt-… for Codex, not Claude', () => {
    const c = receiptConfig({ ...KEY, RECEIPT_MODEL: 'gpt-6-luna' }, true);
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.equal(c.codexModel, 'gpt-6-luna');
    assert.equal(receiptConfig({ CODEX_MODEL: 'gpt-6.1-sol' }, true).codexModel, 'gpt-6.1-sol');
  });
});

describe('pickBetter', () => {
  const r = (recheck: string[]) => ({ recheck }) as unknown as NormalizedReceipt;
  it('keeps the read with fewer failed checks; ties go to the second', () => {
    assert.equal(pickBetter(r(['a']), r([])), 'second');
    assert.equal(pickBetter(r(['a']), r(['b'])), 'second');
    assert.equal(pickBetter(r([]), r(['a', 'b'])), 'first');
    assert.equal(pickBetter(null, r(['a'])), 'second');
    assert.equal(pickBetter(r(['a']), null), 'first');
    assert.equal(pickBetter(null, null), null);
  });
});
