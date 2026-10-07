import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth';
import { decodeImageDataUrl, normalizeReceipt, parseModelOutput } from '../lib/receipt';
import { acquireScanSlot, receiptScanEnabled, runReceiptScan, RECEIPT_MODEL } from '../receipts';

/** Route-local limit; index.ts exempts this path from the global 64 KB cap. */
export const RECEIPT_BODY_LIMIT = 4 * 1024 * 1024;

const scanBody = z.strictObject({ image: z.string().max(RECEIPT_BODY_LIMIT) });

const app = new Hono<AppEnv>();
app.use(requireAuth);

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
    if (!parsed.success) throw new HTTPException(400, { message: 'image: expected a data URL' });
    const image = decodeImageDataUrl(parsed.data.image);
    if ('error' in image) throw new HTTPException(400, { message: image.error });

    const release = acquireScanSlot(c.get('user').id);
    let text: string;
    try {
      text = await runReceiptScan(image, c.req.raw.signal);
    } finally {
      release();
    }
    let result;
    try {
      result = normalizeReceipt(parseModelOutput(text));
    } catch {
      console.error('receipt scan: model output failed validation');
      throw new HTTPException(502, { message: "couldn't read the receipt" });
    }
    return c.json({ ...result, model: RECEIPT_MODEL });
  },
);

export default app;
