import { describe, expect, it } from "vitest"
import {
  compressToBudget,
  fitWithin,
  itemizedNotes,
  receiptPrefill,
  tidyName,
} from "./receipt"
import type { ReceiptDraft } from "./types"

const draft = (over: Partial<ReceiptDraft> = {}): ReceiptDraft => ({
  merchant: "CHAAYOS",
  date: "2026-10-03",
  currency: "INR",
  totalCents: 66000,
  subtotalCents: 62857,
  taxCents: 3143,
  tipCents: null,
  discountCents: null,
  lineItems: [
    { name: "Masala Chai", quantity: 2, amountCents: 24000 },
    { name: "Bun Maska", quantity: 1, amountCents: 12000 },
  ],
  category: "food",
  confidence: "high",
  notes: null,
  ...over,
})

describe("fitWithin", () => {
  it("caps the long edge and keeps aspect ratio", () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 })
  })
  it("never upscales", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
})

describe("compressToBudget", () => {
  // Fake encoder: size ∝ pixels × quality.
  const fake =
    (calls: Array<[number, number, number]>) =>
    (w: number, h: number, q: number) => {
      calls.push([w, h, q])
      return Promise.resolve(new Blob([new Uint8Array(Math.round(w * h * q))]))
    }

  it("returns the first attempt that fits", async () => {
    const calls: Array<[number, number, number]> = []
    const blob = await compressToBudget(4000, 3000, fake(calls), {
      budget: 2_000_000,
    })
    expect(calls).toEqual([[1600, 1200, 0.8]])
    expect(blob.size).toBeLessThanOrEqual(2_000_000)
  })

  it("lowers quality, then size, until under budget", async () => {
    const calls: Array<[number, number, number]> = []
    const blob = await compressToBudget(4000, 3000, fake(calls), {
      budget: 600_000,
    })
    expect(blob.size).toBeLessThanOrEqual(600_000)
    // All four qualities at 1600 fail (min 1600×1200×0.5 = 960k), then 1200 wide.
    expect(calls.slice(0, 4).every(([w]) => w === 1600)).toBe(true)
    expect(calls[4]![0]).toBe(1200)
  })

  it("gives up gracefully, returning the smallest attempt", async () => {
    const calls: Array<[number, number, number]> = []
    const blob = await compressToBudget(4000, 3000, fake(calls), { budget: 10 })
    expect(calls).toHaveLength(16)
    expect(blob.size).toBeGreaterThan(10)
  })
})

describe("tidyName", () => {
  it("title-cases all-caps names only", () => {
    expect(tidyName("CHAAYOS CAFE")).toBe("Chaayos Cafe")
    expect(tidyName("McDonald's")).toBe("McDonald's")
    expect(tidyName("7-ELEVEN")).toBe("7-Eleven")
  })
})

describe("receiptPrefill", () => {
  it("prefills everything when currencies match", () => {
    const p = receiptPrefill(draft(), "INR", false)
    expect(p.description).toBe("Chaayos")
    expect(p.amountCents).toBe(66000)
    expect(p.currency).toBeNull()
    expect(p.date).toBe("2026-10-03")
    expect(p.category).toBe("food")
    expect(p.currencyNotice).toBeNull()
    expect(p.notes?.split("\n")).toHaveLength(3)
    expect(p.notes).toContain("2× Masala Chai")
  })

  it("does not convert or prefill the amount for a group in another currency", () => {
    const p = receiptPrefill(draft({ currency: "USD" }), "INR", false)
    expect(p.amountCents).toBeNull()
    expect(p.currencyNotice).toBe(
      "Receipt is in USD; this group uses INR. Enter the amount in INR."
    )
    expect(p.date).toBe("2026-10-03")
    expect(p.description).toBe("Chaayos")
  })

  it("switches a free-currency form to a supported receipt currency", () => {
    const p = receiptPrefill(draft({ currency: "USD" }), "INR", true)
    expect(p.currency).toBe("USD")
    expect(p.amountCents).toBe(66000)
    expect(p.currencyNotice).toBeNull()
  })

  it("refuses unsupported currencies even when the form can switch", () => {
    const p = receiptPrefill(draft({ currency: "THB" }), "INR", true)
    expect(p.amountCents).toBeNull()
    expect(p.currencyNotice).toMatch(/THB/)
  })

  it("assumes the form currency when the receipt shows none, and says so", () => {
    const p = receiptPrefill(draft({ currency: null }), "INR", false)
    expect(p.amountCents).toBe(66000)
    expect(p.currencyNotice).toMatch(/assumed INR/)
  })

  it("falls back to the first line item for the description", () => {
    expect(
      receiptPrefill(draft({ merchant: null }), "INR", false).description
    ).toBe("Masala Chai")
  })
})

describe("itemizedNotes", () => {
  it("stays under the notes limit and keeps the totals lines", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      name: `A rather long item name number ${i}`,
      quantity: 1,
      amountCents: 1000,
    }))
    const text = itemizedNotes(
      draft({ lineItems: many, tipCents: 500 }),
      "INR"
    )!
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(text).toMatch(/…and \d+ more/)
    expect(text).toMatch(/Tip\/service/)
  })

  it("returns null when there is nothing to list", () => {
    expect(
      itemizedNotes(draft({ lineItems: [], taxCents: null }), "INR")
    ).toBeNull()
  })
})
