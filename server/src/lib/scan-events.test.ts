import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modelLabel, sseFrame, SSE_PING, type ScanEvent } from './scan-events';

/** Minimal SSE reader, the same rules the browser client applies. */
function readFrames(text: string): ScanEvent[] {
  return text
    .split('\n\n')
    .filter((f) => f.trim() && !f.startsWith(':'))
    .map((f) => {
      const data = f
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return JSON.parse(data) as ScanEvent;
    });
}

describe('sseFrame', () => {
  it('frames an event as one event/data pair ending in a blank line', () => {
    const frame = sseFrame({ type: 'status', stage: 'reading' });
    assert.equal(frame, 'event: status\ndata: {"type":"status","stage":"reading"}\n\n');
  });

  it('keeps content with newlines and blank lines inside one data line', () => {
    const tricky: ScanEvent = { type: 'thinking', text: 'line one\n\nevent: error\ndata: {}\n\n' };
    const frame = sseFrame(tricky);
    assert.equal(frame.split('\n\n').length, 2, 'exactly one frame terminator');
    assert.deepEqual(readFrames(frame), [tricky]);
  });

  it('round-trips a stream of events with pings in between', () => {
    const events: ScanEvent[] = [
      { type: 'status', stage: 'reading', model: 'claude-sonnet-5-5' },
      { type: 'thinking', text: 'Reading the totals…' },
      { type: 'partial', fields: { merchant: 'Chaayos', totalCents: 66000 } },
      { type: 'error', code: 'timeout', message: 'too slow' },
    ];
    const wire = events.map(sseFrame).join(SSE_PING);
    assert.deepEqual(readFrames(wire), events);
  });
});

describe('modelLabel', () => {
  it('names Claude models the way the UI shows them', () => {
    assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5');
    assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelLabel('claude-haiku-5-5'), 'Haiku 5.5');
    assert.equal(modelLabel('claude-opus-5'), 'Opus 5');
    assert.equal(modelLabel('gpt-5.6-luna'), 'gpt-5.6-luna');
  });
});
