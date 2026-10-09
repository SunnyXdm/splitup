/**
 * The receipt-scan event stream: what POST /api/receipts/scan emits, and its
 * Server-Sent Events framing. Pure — the route writes these frames to the
 * response body; the client parses them from a fetch() ReadableStream
 * (EventSource can't POST or send the CSRF header).
 */
import type { ReceiptDraft } from './receipt';

export type ScanStage = 'reading' | 'thinking' | 'extracting' | 'checking' | 'escalating';

/** Fields that fill in while the model's JSON is still streaming. */
export interface PartialFields {
  merchant?: string | null;
  date?: string | null;
  currency?: string | null;
  totalCents?: number | null;
  lineItems?: { name: string; amountCents: number }[];
}

export type ScanErrorCode =
  'unavailable' | 'rate_limited' | 'timeout' | 'unreadable' | 'refused' | 'cancelled' | 'failed';

export type ScanEvent =
  | { type: 'status'; stage: ScanStage; model?: string }
  | { type: 'thinking'; text: string }
  | { type: 'partial'; fields: PartialFields }
  | {
      type: 'result';
      draft: ReceiptDraft;
      warnings: string[];
      /** Fields whose checks failed, for highlighting. */
      warningFields: string[];
      model: string;
      modelLabel: string;
      escalated: boolean;
    }
  | { type: 'error'; code: ScanErrorCode; message: string };

/**
 * One SSE frame. `event:` repeats the type for generic SSE tooling; `data:`
 * is single-line JSON (JSON.stringify never emits raw newlines), so a frame
 * can never be split or injected into by content.
 */
export function sseFrame(event: ScanEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A comment frame; keeps proxies from idling out a quiet stream. */
export const SSE_PING = ': ping\n\n';

/** "claude-sonnet-5-5" → "Sonnet 5.5"; anything else is shown as-is. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!m) return model;
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}
