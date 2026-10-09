import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth';
import { isSupportedCurrency } from '../lib/currency';
import { decodeImageDataUrl } from '../lib/receipt';
import { SSE_PING, sseFrame, type ScanEvent } from '../lib/scan-events';
import { acquireScanSlot, receiptScanEnabled, runScan } from '../receipts';

/** Route-local limit; index.ts exempts this path from the global 64 KB cap. */
export const RECEIPT_BODY_LIMIT = 4 * 1024 * 1024;

const scanBody = z.strictObject({
  image: z.string().max(RECEIPT_BODY_LIMIT),
  /** The form's currency (the group's, or the one picked for a direct expense). */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine(isSupportedCurrency)
    .optional(),
  /** BCP 47 tag of the device, e.g. "en-IN". */
  locale: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$/)
    .max(35)
    .optional(),
});

const app = new Hono<AppEnv>();
app.use(requireAuth);

/**
 * Scan a receipt photo. Validation, auth and rate-limit failures are plain
 * JSON errors; once accepted, the response is a text/event-stream of
 * ScanEvents (see lib/scan-events.ts) ending in one `result` or `error`.
 * Closing the connection aborts the upstream model call.
 */
app.post(
  '/scan',
  bodyLimit({
    maxSize: RECEIPT_BODY_LIMIT,
    onError: (c) => c.json({ error: 'image too large' }, 413),
  }),
  async (c) => {
    if (!receiptScanEnabled()) {
      throw new HTTPException(503, { message: 'receipt scanning unavailable' });
    }
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: 'invalid JSON' });
    }
    const parsed = scanBody.safeParse(json);
    if (!parsed.success) {
      const where = parsed.error.issues[0]?.path.join('.') || 'image';
      throw new HTTPException(400, {
        message: where === 'image' ? 'image: expected a data URL' : `${where}: invalid`,
      });
    }
    const image = decodeImageDataUrl(parsed.data.image);
    if ('error' in image) throw new HTTPException(400, { message: image.error });

    const user = c.get('user');
    const release = acquireScanSlot(user.id);
    const hints = {
      formCurrency: parsed.data.currency ?? null,
      defaultCurrency: user.default_currency,
      locale: parsed.data.locale ?? null,
      today: new Date().toISOString().slice(0, 10),
    };

    // Either side going away cancels the model call.
    const abort = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });

    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return stream(
      c,
      async (s) => {
        s.onAbort(() => abort.abort());
        const send = (event: ScanEvent) => {
          if (!s.aborted) void s.write(sseFrame(event));
        };
        const ping = setInterval(() => {
          if (!s.aborted) void s.write(SSE_PING);
        }, 15_000);
        try {
          await runScan(image, hints, abort.signal, send);
        } finally {
          clearInterval(ping);
          release();
        }
      },
      async (_err, s) => {
        release();
        console.error('receipt scan: stream failed');
        if (!s.aborted) {
          await s.write(
            sseFrame({ type: 'error', code: 'failed', message: "Couldn't read that receipt." }),
          );
        }
      },
    );
  },
);

export default app;
