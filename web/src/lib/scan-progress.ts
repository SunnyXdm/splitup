/**
 * The live "what the scanner is doing" state behind the scanning card:
 * folds the stream's status/thinking/partial events into a short log of
 * thoughts and milestones. Pure, unit-tested.
 */
import { formatMoney } from './money';
import { tidyName } from './receipt';
import type { ScanEvent, ScanPartialFields, ScanStage } from './types';

export type ScanLogEntry =
  | { id: number; kind: 'thought'; text: string }
  | { id: number; kind: 'note'; key: string; text: string }
  | { id: number; kind: 'divider'; text: string };

export interface ScanProgress {
  stage: ScanStage;
  /** The model working right now. */
  model: string | null;
  /** Set once a stronger model took over. */
  escalatedTo: string | null;
  entries: ScanLogEntry[];
  fields: ScanPartialFields;
  /** Any summarized thinking arrived (otherwise the log is milestones only). */
  hasThoughts: boolean;
}

/** Keep the DOM small on a long think: older thought text is trimmed. */
const MAX_THOUGHT_CHARS = 6000;

export const INITIAL_PROGRESS: ScanProgress = {
  stage: 'reading',
  model: null,
  escalatedTo: null,
  entries: [],
  fields: {},
  hasThoughts: false,
};

/** "claude-sonnet-5-5" → "Sonnet 5.5"; other ids pass through. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!m) return model;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

export function stageLabel(p: ScanProgress): string {
  switch (p.stage) {
    case 'reading':
      return 'Reading receipt…';
    case 'thinking':
      return 'Thinking it through…';
    case 'extracting':
      return 'Filling in the form…';
    case 'checking':
      return 'Checking the math…';
    case 'escalating':
      // The model's name sits on the line below; keep this short enough not to truncate.
      return 'Re-checking…';
  }
}

function money(cents: number, currency: string | null | undefined): string {
  if (currency) {
    try {
      return formatMoney(cents, currency);
    } catch {
      // unknown code: fall through
    }
  }
  return (cents / 100).toFixed(2);
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Add or replace the milestone note with this key (so "3 items" updates in place). */
function upsertNote(entries: ScanLogEntry[], nextId: number, key: string, text: string) {
  const at = entries.findIndex((e) => e.kind === 'note' && e.key === key);
  if (at >= 0) {
    const copy = entries.slice();
    copy[at] = { ...(copy[at] as Extract<ScanLogEntry, { kind: 'note' }>), text };
    return copy;
  }
  return [...entries, { id: nextId, kind: 'note' as const, key, text }];
}

export function applyScanEvent(p: ScanProgress, event: ScanEvent): ScanProgress {
  const nextId = (p.entries.at(-1)?.id ?? 0) + 1;
  switch (event.type) {
    case 'status': {
      const next: ScanProgress = { ...p, stage: event.stage, model: event.model ?? p.model };
      if (event.stage === 'escalating') {
        next.escalatedTo = event.model ?? null;
        next.entries = [
          ...p.entries,
          {
            id: nextId,
            kind: 'divider',
            text: event.model
              ? `Something didn't add up — re-checking with ${modelLabel(event.model)}`
              : "Something didn't add up — re-checking",
          },
        ];
      } else if (event.stage === 'checking') {
        const key = p.escalatedTo ? 'checking-2' : 'checking';
        next.entries = upsertNote(p.entries, nextId, key, 'Checking that it all adds up');
      }
      return next;
    }
    case 'thinking': {
      const last = p.entries.at(-1);
      let entries: ScanLogEntry[];
      if (last?.kind === 'thought') {
        let text = last.text + event.text;
        if (text.length > MAX_THOUGHT_CHARS) text = `…${text.slice(-MAX_THOUGHT_CHARS)}`;
        entries = [...p.entries.slice(0, -1), { ...last, text }];
      } else {
        entries = [...p.entries, { id: nextId, kind: 'thought', text: event.text.trimStart() }];
      }
      return { ...p, entries, hasThoughts: true };
    }
    case 'partial': {
      const f = event.fields;
      const pass = p.escalatedTo ? '-2' : '';
      let entries = p.entries;
      let id = nextId;
      const note = (key: string, text: string) => {
        const before = entries;
        entries = upsertNote(entries, id, key + pass, text);
        if (entries.length > before.length) id += 1;
      };
      if (f.merchant && f.merchant !== p.fields.merchant)
        note('merchant', `Found ${tidyName(f.merchant)}`);
      if (f.date && f.date !== p.fields.date) note('date', `Dated ${prettyDate(f.date)}`);
      const n = f.lineItems?.length ?? 0;
      if (n > 0 && n !== (p.fields.lineItems?.length ?? 0)) {
        note('items', n === 1 ? '1 item so far' : `${n} items so far`);
      }
      if (f.totalCents != null && f.totalCents !== p.fields.totalCents) {
        note('total', `Total ${money(f.totalCents, f.currency)}`);
      }
      return { ...p, entries, fields: { ...p.fields, ...f } };
    }
    default:
      return p;
  }
}
