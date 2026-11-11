import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { UserRow } from '../db';
import { isSupportedCurrency } from '../lib/currency';
import { MAX_IMAGE_BYTES, decodeImageDataUrl, type ReceiptDraft } from '../lib/receipt';
import type { ScanEvent } from '../lib/scan-events';
import { acquireScanSlot, receiptScanEnabled, runScan } from '../receipts';
import { ToolError, money } from './support';

const SCAN_TIMEOUT_MS = 180_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** True for addresses a server-side fetch must never reach (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

async function assertPublicHttps(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError('image_url is not a URL');
  }
  if (u.protocol !== 'https:') throw new ToolError('image_url must be https');
  if (u.username || u.password) throw new ToolError('image_url must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal)$/i.test(host)) {
    throw new ToolError('image_url must be on a public host name');
  }
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new ToolError(`could not resolve ${host}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new ToolError('image_url must point to a public address');
  }
  return u;
}

/**
 * Downloads a receipt image from a public https URL: no private addresses,
 * redirects re-checked hop by hop, size capped while streaming.
 */
async function fetchImage(raw: string, signal: AbortSignal): Promise<string> {
  let url = await assertPublicHttps(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { accept: 'image/jpeg,image/png,image/webp' },
    }).catch(() => {
      throw new ToolError('could not download image_url');
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new ToolError('image_url redirects too many times');
      url = await assertPublicHttps(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok || !res.body) throw new ToolError(`image_url answered ${res.status}`);
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      throw new ToolError('image_url must be a JPEG, PNG or WebP image');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new ToolError('image is larger than 3 MB');
      chunks.push(Buffer.from(chunk));
    }
    return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
  }
}

function sniffMime(b64: string): string | null {
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp';
  return null;
}

const draftOut = (d: ReceiptDraft) => {
  const cur = d.currency && isSupportedCurrency(d.currency) ? d.currency : null;
  const m = (cents: number | null) =>
    cents === null ? null : cur ? money(cents, cur) : { minor: cents };
  return {
    merchant: d.merchant,
    date: d.date,
    currency: d.currency,
    total: m(d.totalCents),
    subtotal: m(d.subtotalCents),
    tax: m(d.taxCents),
    tipAndFees: m(d.tipCents),
    discount: m(d.discountCents),
    suggestedCategory: d.category,
    confidence: d.confidence,
    lineItems: d.lineItems.map((li) => ({
      name: li.name,
      quantity: li.quantity,
      amount: m(li.amountCents),
    })),
    taxes: d.taxes.map((t) => ({ ...t, amount: m(t.amountCents) })),
    fees: d.fees.map((f) => ({ ...f, amount: m(f.amountCents) })),
    discounts: d.discounts.map((x) => ({ ...x, amount: m(x.amountCents) })),
    notes: d.notes,
  };
};

export async function scanReceipt(
  user: UserRow,
  args: { image_base64?: string; mime_type?: string; image_url?: string; currency?: string },
  signal: AbortSignal,
) {
  if (!receiptScanEnabled()) throw new ToolError('receipt scanning is not enabled on this server');
  if ((args.image_base64 === undefined) === (args.image_url === undefined)) {
    throw new ToolError('pass exactly one of image_base64 or image_url');
  }
  const abort = AbortSignal.any([signal, AbortSignal.timeout(SCAN_TIMEOUT_MS)]);
  let dataUrl: string;
  if (args.image_url !== undefined) {
    dataUrl = await fetchImage(args.image_url, abort);
  } else {
    const raw = args.image_base64!.replace(/\s+/g, '');
    if (raw.startsWith('data:')) {
      dataUrl = raw;
    } else {
      const mime = args.mime_type ?? sniffMime(raw);
      if (!mime) throw new ToolError('pass mime_type (image/jpeg, image/png or image/webp)');
      dataUrl = `data:${mime};base64,${raw}`;
    }
  }
  const image = decodeImageDataUrl(dataUrl);
  if ('error' in image) throw new ToolError(image.error);
  const release = acquireScanSlot(user.id);
  let outcome: ScanEvent | null = null;
  try {
    await runScan(
      image,
      {
        formCurrency: args.currency ?? null,
        defaultCurrency: user.default_currency,
        locale: null,
        today: new Date().toISOString().slice(0, 10),
      },
      abort,
      (event) => {
        if (event.type === 'result' || event.type === 'error') outcome = event;
      },
    );
  } finally {
    release();
  }
  const done = outcome as ScanEvent | null;
  if (!done || done.type === 'error') {
    throw new ToolError(done?.type === 'error' ? done.message : 'could not read that receipt');
  }
  if (done.type !== 'result') throw new ToolError('could not read that receipt');
  return {
    saved: false,
    draft: draftOut(done.draft),
    warnings: done.warnings,
    model: done.modelLabel,
  };
}
