/**
 * Receipt scanning on the client: shrink the photo before upload, and turn a
 * scanned draft into form prefill values. Everything except the canvas/bitmap
 * glue in `downscaleImage` is pure and unit-tested.
 */
import { CURRENCIES, currencyDigits, formatMoney } from "./money"
import type { Category, ReceiptDraft } from "./types"

export const MAX_EDGE = 1600
export const TARGET_BYTES = 1.5 * 1024 * 1024
const QUALITIES = [0.8, 0.7, 0.6, 0.5]

/** Scale (w, h) down so the long edge is ≤ maxEdge; never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= maxEdge || long === 0) return { width, height }
  const scale = maxEdge / long
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export type Encoder = (
  width: number,
  height: number,
  quality: number
) => Promise<Blob>

/**
 * Encode at the capped size, stepping JPEG quality down and then the size
 * down until the blob fits the budget. Returns the last attempt even if it is
 * still over (the server enforces the hard limit).
 */
export async function compressToBudget(
  srcWidth: number,
  srcHeight: number,
  encode: Encoder,
  {
    maxEdge = MAX_EDGE,
    budget = TARGET_BYTES,
  }: { maxEdge?: number; budget?: number } = {}
): Promise<Blob> {
  let edge = maxEdge
  let blob: Blob | null = null
  for (let round = 0; round < 4; round++) {
    const { width, height } = fitWithin(srcWidth, srcHeight, edge)
    for (const q of QUALITIES) {
      blob = await encode(width, height, q)
      if (blob.size <= budget) return blob
    }
    edge = Math.round(Math.max(width, height) * 0.75)
  }
  return blob!
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(blob)
  })
}

type Drawable = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function decode(file: Blob): Promise<Drawable> {
  try {
    // Applies EXIF orientation so phone photos aren't sideways.
    const bmp = await createImageBitmap(file, {
      imageOrientation: "from-image",
    })
    return {
      source: bmp,
      width: bmp.width,
      height: bmp.height,
      close: () => bmp.close(),
    }
  } catch {
    // Fallback for formats createImageBitmap can't take (browsers apply
    // EXIF orientation to <img> by default).
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => {},
      }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Photo → JPEG data URL, long edge ≤ 1600px, aiming for < 1.5 MB. */
export async function downscaleImage(file: Blob): Promise<string> {
  const img = await decode(file)
  try {
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("canvas unavailable")
    const encode: Encoder = (width, height, quality) => {
      canvas.width = width
      canvas.height = height
      // White under any transparency (PNG screenshots) instead of black.
      ctx.fillStyle = "#fff"
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img.source, 0, 0, width, height)
      return new Promise((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
          "image/jpeg",
          quality
        )
      )
    }
    const blob = await compressToBudget(img.width, img.height, encode)
    return await blobToDataUrl(blob)
  } finally {
    img.close()
  }
}

// ----------------------------------------------------------------- prefill

export interface ReceiptPrefill {
  description: string | null
  /** Total in the form currency's minor units; null when unknown or mismatched. */
  amountCents: number | null
  /** Switch the form to this currency first (only for free-currency forms). */
  currency: string | null
  date: string | null
  category: Category
  notes: string | null
  /** Shown above the form instead of silently converting. */
  currencyNotice: string | null
}

const MAX_NOTES = 1000

/** "CHAAYOS CAFE" → "Chaayos Cafe"; mixed-case names are left alone. */
export function tidyName(name: string): string {
  if (name !== name.toUpperCase() || !/\p{L}/u.test(name)) return name
  return name
    .toLowerCase()
    .replace(
      /(^|[\s\-/&(])(\p{L})/gu,
      (_, sep: string, ch: string) => sep + ch.toUpperCase()
    )
}

/** Compact itemized notes: "2× Masala Chai — ₹240.00", then tax/tip/discount. */
export function itemizedNotes(
  draft: ReceiptDraft,
  currency: string
): string | null {
  const money = (c: number) => formatMoney(c, currency)
  const lines = draft.lineItems.map((it) => {
    const qty =
      it.quantity !== null ? `${Number(it.quantity.toFixed(3))}× ` : ""
    return `${qty}${it.name} — ${money(it.amountCents)}`
  })
  const extra: string[] = []
  if (draft.taxCents) extra.push(`Tax — ${money(draft.taxCents)}`)
  if (draft.tipCents) extra.push(`Tip/service — ${money(draft.tipCents)}`)
  if (draft.discountCents)
    extra.push(`Discount — −${money(draft.discountCents)}`)
  if (lines.length === 0 && extra.length === 0) return null

  // Keep within the notes limit, dropping items (not totals) from the end.
  const tail = (dropped: number) =>
    [...(dropped > 0 ? [`…and ${dropped} more`] : []), ...extra].join("\n")
  let kept = lines.length
  const build = () =>
    [...lines.slice(0, kept), tail(lines.length - kept)]
      .filter(Boolean)
      .join("\n")
  let text = build()
  while (text.length > MAX_NOTES && kept > 0) {
    kept -= 1
    text = build()
  }
  return text.slice(0, MAX_NOTES)
}

/**
 * Map a scanned draft onto the form. The amount is only prefilled when the
 * receipt's currency is the form's (or the form can switch to it) — never
 * converted. A receipt with no visible currency is assumed to be in the form's.
 */
export function receiptPrefill(
  draft: ReceiptDraft,
  formCurrency: string,
  canChangeCurrency: boolean
): ReceiptPrefill {
  const first = draft.lineItems[0]?.name ?? null
  const description = draft.merchant ? tidyName(draft.merchant) : first
  const receiptCurrency = draft.currency ?? formCurrency

  let currency: string | null = null
  let currencyNotice: string | null = null
  let usable = receiptCurrency === formCurrency
  if (
    !usable &&
    canChangeCurrency &&
    (CURRENCIES as readonly string[]).includes(receiptCurrency)
  ) {
    currency = receiptCurrency
    usable = true
  } else if (!usable) {
    currencyNotice = canChangeCurrency
      ? `Receipt is in ${receiptCurrency}, which Splitup doesn't support — enter the amount yourself.`
      : `Receipt is in ${receiptCurrency}; this group uses ${formCurrency}. Enter the amount in ${formCurrency}.`
  }
  if (draft.currency === null && draft.totalCents !== null) {
    currencyNotice = `The receipt doesn't show a currency — assumed ${formCurrency}.`
  }

  // Notes amounts are always in the receipt's own currency, mismatched or not
  // (when it's unsupported, Intl can still format any ISO code).
  let notesCurrency = receiptCurrency
  try {
    currencyDigits(notesCurrency)
  } catch {
    notesCurrency = formCurrency
  }

  return {
    description: description ? description.slice(0, 200) : null,
    amountCents: usable ? draft.totalCents : null,
    currency,
    date: draft.date,
    category: draft.category,
    notes: itemizedNotes(draft, notesCurrency),
    currencyNotice,
  }
}
