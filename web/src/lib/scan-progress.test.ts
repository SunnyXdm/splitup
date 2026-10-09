import { describe, expect, it } from 'vitest';
import { applyScanEvent, INITIAL_PROGRESS, modelLabel, stageLabel } from './scan-progress';
import type { ScanEvent } from './types';

const run = (events: ScanEvent[]) => events.reduce(applyScanEvent, INITIAL_PROGRESS);

describe('scan progress', () => {
  it('joins streamed thinking into one growing thought', () => {
    const p = run([
      { type: 'status', stage: 'reading', model: 'claude-sonnet-5-5' },
      { type: 'status', stage: 'thinking', model: 'claude-sonnet-5-5' },
      { type: 'thinking', text: 'Reading the ' },
      { type: 'thinking', text: 'totals.' },
    ]);
    expect(p.entries).toEqual([{ id: 1, kind: 'thought', text: 'Reading the totals.' }]);
    expect(p.hasThoughts).toBe(true);
    expect(stageLabel(p)).toBe('Thinking it through…');
  });

  it('turns partial fields into milestones, updating counts in place', () => {
    const p = run([
      { type: 'partial', fields: { merchant: 'Chaayos' } },
      {
        type: 'partial',
        fields: { merchant: 'Chaayos', lineItems: [{ name: 'Chai', amountCents: 24000 }] },
      },
      {
        type: 'partial',
        fields: {
          merchant: 'Chaayos',
          currency: 'INR',
          lineItems: [
            { name: 'Chai', amountCents: 24000 },
            { name: 'Poha', amountCents: 15000 },
          ],
          totalCents: 66000,
        },
      },
    ]);
    expect(p.entries.map((e) => e.text)).toEqual([
      'Found Chaayos',
      '2 items so far',
      'Total ₹660.00',
    ]);
    expect(p.hasThoughts).toBe(false);
  });

  it('marks an escalation with a divider and the new model', () => {
    const p = run([
      { type: 'status', stage: 'checking', model: 'claude-sonnet-5-5' },
      { type: 'status', stage: 'escalating', model: 'claude-opus-5-5' },
      { type: 'thinking', text: 'Re-reading the total line.' },
    ]);
    expect(p.escalatedTo).toBe('claude-opus-5-5');
    expect(p.entries.map((e) => e.kind)).toEqual(['note', 'divider', 'thought']);
    expect(p.entries[1]!.text).toMatch(/Opus 5\.5/);
    expect(stageLabel({ ...p, stage: 'escalating' })).toBe('Re-checking…');
  });

  it('labels models', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
  });
});
