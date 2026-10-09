import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Sparkles, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { foreignTotalLabel } from '@/lib/receipt';
import { modelLabel, stageLabel, type ScanProgress } from '@/lib/scan-progress';
import { cn } from '@/lib/utils';

/**
 * A soft signal wash over a field the scan just filled. Keyed by a counter
 * so each fill replays it; an overlay, so the input itself never re-mounts
 * or moves. Reduced motion collapses it to nothing (index.css).
 */
export function FillFlash({ n, className }: { n: number; className?: string }) {
  if (n === 0) return null;
  return (
    <span
      key={n}
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 rounded-full bg-signal opacity-0 animate-[field-wash_1.6s_ease-out]',
        className,
      )}
    />
  );
}

/**
 * While a receipt is being read: the photo with the scan line, what stage
 * it's at, and a live panel of the model's summarized thinking plus
 * milestones ("Found Chaayos", "4 items so far") as fields fill in.
 */
export function ScanningCard({
  photo,
  progress,
  onCancel,
}: {
  photo: string | null;
  progress: ScanProgress;
  onCancel: () => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Follow the newest line unless the user scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = progress.entries.at(-1);
  const tail = last ? `${last.id}:${last.text.length}` : '';
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail, open]);

  const model = progress.model ? modelLabel(progress.model) : null;
  const hasLog = progress.entries.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-panel border border-border bg-card p-3">
      <div className="flex items-center gap-4 pr-1">
        {/* The captured photo with a scan line sweeping down it (transform only). */}
        <div
          aria-hidden="true"
          className="relative h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-muted"
        >
          {photo ? <img src={photo} alt="" className="size-full object-cover" /> : null}
          <div className="absolute inset-x-0 top-0 h-6 animate-[scan-sweep_1.8s_ease-in-out_infinite] [--scan-travel:80px]">
            <div className="h-full bg-linear-to-b from-transparent to-signal/35" />
            <div className="h-0.5 bg-signal shadow-[0_0_8px_var(--signal)]" />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <Spinner />
            <span className="truncate">{stageLabel(progress)}</span>
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {model ? `${model} · ` : ''}
            {elapsed}s
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {hasLog ? (
        <div className="rounded-2xl bg-muted/60">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            className="hit-area flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Sparkles className="size-3.5 shrink-0 text-signal" aria-hidden="true" />
            <span className="flex-1">{progress.hasThoughts ? 'Thinking' : 'Progress'}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-4 transition-transform', open && 'rotate-180')}
            />
          </button>
          {open ? (
            <div
              id={panelId}
              ref={scroller}
              aria-label="What the scanner is doing"
              aria-live="off"
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              className="max-h-36 overflow-y-auto overscroll-contain px-3 pb-3 text-sm leading-relaxed outline-none [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)] focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <div className="flex flex-col gap-1.5 pt-3">
                {progress.entries.map((e) =>
                  e.kind === 'thought' ? (
                    <p
                      key={e.id}
                      className="animate-[thought-in_0.3s_ease-out] whitespace-pre-line text-foreground/80"
                    >
                      {e.text}
                    </p>
                  ) : e.kind === 'divider' ? (
                    <p
                      key={e.id}
                      className="mt-1 flex animate-[thought-in_0.3s_ease-out] items-center gap-2 border-t border-border pt-2 text-xs font-medium text-warning"
                    >
                      {e.text}
                    </p>
                  ) : (
                    <p
                      key={e.id}
                      className="flex animate-[thought-in_0.3s_ease-out] items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-signal" />
                      {e.text}
                    </p>
                  ),
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ScanReview {
  warnings: string[];
  confidence: 'high' | 'medium' | 'low';
  /** The model's own remark about something unclear, if any. */
  remark: string | null;
  /** "Scanned with Sonnet 5.5" / "Re-checked with Opus 5.5". */
  byline: string | null;
  /** The receipt's total in another currency than the form's. */
  foreignTotal: { currency: string; cents: number } | null;
}

/** After a scan: what to double-check, who read it, and a foreign total. */
export function ScanReviewBanner({
  review,
  formCurrency,
  amountRaw,
  onAmountChange,
  onRescan,
  rescanDisabled,
  onDismiss,
}: {
  review: ScanReview;
  formCurrency: string;
  amountRaw: string;
  onAmountChange: (raw: string) => void;
  onRescan: () => void;
  rescanDisabled: boolean;
  onDismiss: () => void;
}) {
  const low = review.confidence === 'low';
  const amountId = useId();
  return (
    <div role="status" className="flex flex-col gap-2 rounded-panel bg-warning/10 p-4 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="font-medium">Check the amounts before saving</p>
          {review.byline ? <p className="text-xs text-muted-foreground">{review.byline}</p> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-mt-1 -mr-1 rounded-full"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      {review.foreignTotal ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-card px-3 py-3">
          <p className="font-medium tabular-nums">
            Receipt total: {foreignTotalLabel(review.foreignTotal)}
          </p>
          <label htmlFor={amountId} className="text-muted-foreground">
            What did it cost in {formCurrency}?
          </label>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            value={amountRaw}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder={`Amount in ${formCurrency}`}
            className="h-11 w-full rounded-full border border-input bg-transparent px-4 text-base tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring md:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            The items and receipt total stay in the notes, in {review.foreignTotal.currency}.
          </p>
        </div>
      ) : null}
      {low ? (
        <p className="font-medium text-warning">
          Low confidence — the photo was hard to read. Double-check every field.
        </p>
      ) : review.confidence === 'medium' ? (
        <p className="text-muted-foreground">Some values were hard to read.</p>
      ) : null}
      {review.warnings.length > 0 || review.remark ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          {review.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
          {review.remark ? <li>{review.remark}</li> : null}
        </ul>
      ) : null}
      <p className="text-muted-foreground">
        Pick who paid and how to split, then add it.
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1.5 py-0 align-baseline"
          disabled={rescanDisabled}
          onClick={onRescan}
        >
          Scan again
        </Button>
      </p>
    </div>
  );
}
