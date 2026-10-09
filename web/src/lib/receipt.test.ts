import { describe, expect, it } from "vitest"
import {
  compressToBudget,
  fitWithin,
  foreignTotalLabel,
  itemizedNotes,
  partialPrefill,
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
      budget: 4_000_000,
    })
    // 2000px long edge at JPEG 0.85 first (EXIF-rotated upstream).
    expect(calls).toEqual([[2000, 1500, 0.85]])
    expect(blob.size).toBeLessThanOrEqual(4_000_000)
  })

  it("lowers quality, then size, until under budget", async () => {
    const calls: Array<[number, number, number]> = []
    const blob = await compressToBudget(4000, 3000, fake(calls), {
      budget: 1_500_000,
    })
    expect(blob.size).toBeLessThanOrEqual(1_500_000)
    // All four qualities at 2000 fail (min 2000×1500×0.6 = 1.8M), then 1500 wide.
    expect(calls.slice(0, 4).every(([w]) => w === 2000)).toBe(true)
    expect(calls[4]![0]).toBe(1500)
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
    const p = receiptPrefill(
      draft({ currency: "LKR", totalCents: 78000 }),
      "INR",
      false
    )
    expect(p.amountCents).toBeNull()
    expect(p.currencyNotice).toBe(
      "Receipt is in LKR; this group uses INR. Enter the amount in INR."
    )
    // …but the receipt total is kept, for the banner and in the notes.
    expect(p.foreignTotal).toEqual({ currency: "LKR", cents: 78000 })
    expect(foreignTotalLabel(p.foreignTotal!)).toMatch(/^LKR 780[.,]00$/)
    expect(p.notes).toMatch(/Receipt total — /)
    expect(p.date).toBe("2026-10-03")
    expect(p.description).toBe("Chaayos")
  })

  it("prefills a Sri Lankan receipt on a free-currency form (any ISO code)", () => {
    const p = receiptPrefill(
      draft({ currency: "LKR", totalCents: 78000 }),
      "INR",
      true
    )
    expect(p.currency).toBe("LKR")
    expect(p.amountCents).toBe(78000)
    expect(p.foreignTotal).toBeNull()
    expect(p.currencyNotice).toBeNull()
  })

  it("switches a free-currency form to a supported receipt currency", () => {
    const p = receiptPrefill(draft({ currency: "USD" }), "INR", true)
    expect(p.currency).toBe("USD")
    expect(p.amountCents).toBe(66000)
    expect(p.currencyNotice).toBeNull()
  })

  it("refuses codes this browser doesn't know, keeping the total", () => {
    const p = receiptPrefill(draft({ currency: "XQQ" }), "INR", true)
    expect(p.amountCents).toBeNull()
    expect(p.currencyNotice).toMatch(/XQQ/)
    expect(p.foreignTotal).toEqual({ currency: "XQQ", cents: 66000 })
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

describe("partialPrefill", () => {
  it("fills what has arrived; the amount waits for a matching currency", () => {
    expect(partialPrefill({ merchant: "CHAAYOS" }, "INR", false)).toEqual({
      description: "Chaayos",
    })
    expect(
      partialPrefill({ currency: "INR", totalCents: 66000 }, "INR", false)
    ).toEqual({ amountCents: 66000 })
    expect(partialPrefill({ totalCents: 66000 }, "INR", false)).toEqual({})
    expect(
      partialPrefill({ currency: "LKR", totalCents: 78000 }, "INR", false)
    ).toEqual({})
    expect(
      partialPrefill({ currency: "LKR", totalCents: 78000 }, "INR", true)
    ).toEqual({ currency: "LKR", amountCents: 78000 })
  })
})

describe("itemizedNotes", () => {
  it("lists each printed tax, charge and discount", () => {
    const text = itemizedNotes(
      draft({
        taxes: [
          {
            kind: "CGST",
            label: "CGST 2.5%",
            ratePercent: 2.5,
            amountCents: 1571,
            inclusive: false,
          },
          {
            kind: "SGST",
            label: "SGST 2.5%",
            ratePercent: 2.5,
            amountCents: 1572,
            inclusive: false,
          },
        ],
        fees: [{ kind: "ROUND_OFF", label: "Round off", amountCents: -43 }],
        discounts: [{ label: "Member", amountCents: 500 }],
      }),
      "INR"
    )!
    expect(text).toMatch(/CGST 2\.5% — ₹15\.71/)
    expect(text).toMatch(/SGST 2\.5% — ₹15\.72/)
    expect(text).toMatch(/Round off — −₹0\.43/)
    expect(text).toMatch(/Member — −₹5\.00/)
  })

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
