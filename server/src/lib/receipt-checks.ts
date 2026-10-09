/**
 * Deterministic checks on a scanned receipt. Models misread digits; arithmetic
 * doesn't. Everything here is pure and unit-tested (receipt-checks.test.ts).
 */

// ------------------------------------------------------------ amount parsing

/**
 * Printed amount text → integer minor units, or null when it isn't one clear
 * number. Handles currency markers ("Rs.", "₹", "LKR", "/-"), Indian lakh
 * grouping ("1,23,456.50"), western grouping ("1,234.50"), European decimal
 * commas ("1.234,50") and bare integers. Never guesses on ambiguous text.
 */
export function parsePrintedAmount(raw: string, digits: number): number | null {
  let s = raw
    .replace(/[\s  ]/g, '')
    .replace(/\/-$/, '')
    .replace(/^(?:rs\.?|inr|lkr|₹|රු\.?|ரூ\.?|[a-z]{3}|[$€£¥])+/i, '')
    .replace(/(?:rs\.?|inr|lkr|₹|[a-z]{3})+$/i, '');
  let negative = false;
  if (/^-|^\(.*\)$|-$/.test(s)) {
    negative = true;
    s = s.replace(/^\(|\)$/g, '').replace(/^-|-$/g, '');
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  let whole: string;
  let frac = '';
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    const at = s.lastIndexOf(dec);
    whole = s.slice(0, at);
    frac = s.slice(at + 1);
    if (!isGroupedNumber(whole, grp) || !/^\d+$/.test(frac)) return null;
    whole = whole.split(grp).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      if (!isGroupedNumber(s, sep)) return null;
      whole = parts.join('');
    } else {
      const [w, f] = parts as [string, string];
      // "1,234" / "12,345" is grouping; "12.50" / "12,5" is a decimal mark.
      if (f.length === 3 && sep === ',' && w.length > 0) {
        whole = w + f;
      } else if (f.length === 3 && sep === '.' && digits !== 3 && w.length > 0) {
        // "1.234" in a 2-digit currency is European grouping.
        whole = w + f;
      } else {
        whole = w;
        frac = f;
      }
    }
  } else {
    whole = s;
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac) || (whole === '' && frac === '')) return null;
  if (whole.length > 13 || frac.length > Math.max(digits, 3)) return null;
  const padded = frac.padEnd(digits + 1, '0');
  let minor =
    Number(whole || '0') * 10 ** digits + (digits > 0 ? Number(padded.slice(0, digits)) : 0);
  if (Number(padded[digits] ?? '0') >= 5) minor += 1;
  return negative ? -minor : minor;
}

/**
 * "1,234,567" (3-digit groups) or Indian "12,34,567" (2-digit groups then a
 * final 3-digit group) with the given separator.
 */
export function isGroupedNumber(s: string, sep: ',' | '.'): boolean {
  const parts = s.split(sep);
  if (parts.length === 1) return /^\d+$/.test(s);
  if (/^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p))) return true;
  const esc = sep === '.' ? '\\.' : ',';
  return new RegExp(`^\\d{1,2}(${esc}\\d{2})+${esc}\\d{3}$`).test(s);
}

// ------------------------------------------------------------------- GSTIN

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The check character a 14-character GSTIN prefix should end with. */
export function gstinCheckChar(first14: string): string | null {
  if (!/^[0-9A-Z]{14}$/.test(first14)) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}

/**
 * India GSTIN: 2-digit state code (01–38, 97, 99), PAN (5 letters, 4 digits,
 * 1 letter), entity code, 'Z' (or a letter for special registrations), and
 * a mod-36 check character.
 */
export function isValidGstin(raw: string): boolean {
  const g = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][A-Z][0-9A-Z]$/.test(g)) return false;
  const state = Number(g.slice(0, 2));
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return false;
  return gstinCheckChar(g.slice(0, 14)) === g[14];
}

// ------------------------------------------------------------------- dates

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

/**
 * Does the printed date text plausibly say this ISO date? Accepts any
 * day/month order (and 2-digit years) — the point is to catch a model that
 * typed a date that isn't on the paper, not to re-decide the order.
 */
export function rawDateMatches(raw: string, iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const nums = (raw.match(/\d+/g) ?? []).map(Number);
  const hasYear = nums.includes(Number(y)) || nums.includes(Number(y) % 100);
  const hasMonth = nums.includes(Number(mo)) || monthFromName(raw) === Number(mo);
  return hasYear && hasMonth && nums.includes(Number(d));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthFromName(raw: string): number | null {
  const m = /\b([a-z]{3})[a-z]*\b/i.exec(raw);
  if (!m) return null;
  const i = MONTHS.indexOf(m[1]!.toLowerCase());
  return i < 0 ? null : i + 1;
}

/**
 * True when a numeric date like "03/10/2026" could be read either way (both
 * leading parts ≤ 12 and different), so the locale decides.
 */
export function isAmbiguousNumericDate(raw: string): boolean {
  const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s*$/.exec(raw);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a <= 12 && b <= 12 && a !== b;
}

// -------------------------------------------------------------- reconcile

export type TaxKind =
  'CGST' | 'SGST' | 'UTGST' | 'IGST' | 'CESS' | 'GST' | 'VAT' | 'SSCL' | 'SALES_TAX' | 'OTHER';

export interface CheckTax {
  kind: TaxKind;
  ratePercent: number | null;
  amountCents: number;
  /** Already included in the item prices (VAT-inclusive bills). */
  inclusive: boolean;
}

export interface CheckInput {
  digits: number;
  totalCents: number | null;
  subtotalCents: number | null;
  itemCents: number[];
  taxes: CheckTax[];
  /** Service charge, tips, delivery, packaging, round-off (may be negative). */
  feeCents: number[];
  discountCents: number[];
  gstin: string | null;
  date: string | null;
  dateRaw: string | null;
  today: string;
}

export type IssueField = 'total' | 'subtotal' | 'line_items' | 'taxes' | 'gstin' | 'date';

export interface Issue {
  field: IssueField;
  message: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Run every arithmetic and format check. Each failure is an Issue naming the
 * field to look at; an empty list means the receipt is internally consistent.
 */
export function checkReceipt(r: CheckInput): Issue[] {
  const issues: Issue[] = [];
  const unit = 10 ** r.digits;
  // Unprinted rounding to the nearest whole unit is common; allow one unit.
  const near = (a: number, b: number, tol = unit) => Math.abs(a - b) <= tol;

  const items = sum(r.itemCents);
  const exclusiveTax = sum(r.taxes.filter((t) => !t.inclusive).map((t) => t.amountCents));
  const fees = sum(r.feeCents);
  const discounts = sum(r.discountCents);

  if (r.totalCents !== null) {
    const candidates: number[] = [];
    if (r.itemCents.length > 0) {
      candidates.push(items + exclusiveTax + fees - discounts);
    }
    if (r.subtotalCents !== null) {
      candidates.push(r.subtotalCents + exclusiveTax + fees - discounts);
      // Some bills print the subtotal after the discount.
      candidates.push(r.subtotalCents + exclusiveTax + fees);
    }
    if (candidates.length > 0 && !candidates.some((c) => near(c, r.totalCents!))) {
      issues.push({
        field: 'total',
        message: "The items, taxes and charges don't add up to the total.",
      });
    }
  }
  if (r.subtotalCents !== null && r.itemCents.length > 0) {
    const ok =
      near(items, r.subtotalCents, Math.max(1, r.itemCents.length)) ||
      near(items - discounts, r.subtotalCents, Math.max(1, r.itemCents.length));
    if (!ok) {
      issues.push({ field: 'line_items', message: "The line items don't add up to the subtotal." });
    }
  }

  // Each tax: rate × base ≈ amount. Base = the pre-tax value of the goods.
  const base = r.subtotalCents ?? (r.itemCents.length > 0 ? items - discounts : null);
  if (base !== null && base > 0) {
    for (const t of r.taxes) {
      if (t.ratePercent === null || t.ratePercent <= 0 || t.ratePercent > 50) continue;
      const expected = t.inclusive
        ? (base * t.ratePercent) / (100 + t.ratePercent)
        : (base * t.ratePercent) / 100;
      // Taxes are sometimes levied on base + service charge: allow 3% + 1 unit.
      const tol = Math.max(unit, Math.abs(expected) * 0.03 + unit / 2);
      const onFees = t.inclusive ? expected : ((base + fees) * t.ratePercent) / 100;
      if (!near(t.amountCents, expected, tol) && !near(t.amountCents, onFees, tol)) {
        issues.push({
          field: 'taxes',
          message: `${t.kind} at ${t.ratePercent}% doesn't match its amount.`,
        });
      }
    }
  }

  const of = (k: TaxKind) => r.taxes.filter((t) => t.kind === k);
  const cgst = of('CGST');
  const sgst = [...of('SGST'), ...of('UTGST')];
  const igst = of('IGST');
  if (cgst.length > 0 && sgst.length > 0) {
    const c = sum(cgst.map((t) => t.amountCents));
    const s = sum(sgst.map((t) => t.amountCents));
    // Split-rounding leaves at most a minor unit or two between the halves.
    if (!near(c, s, Math.max(2, cgst.length + sgst.length))) {
      issues.push({ field: 'taxes', message: "CGST and SGST should be equal but aren't." });
    }
  } else if (cgst.length + sgst.length === 1 && igst.length === 0) {
    issues.push({
      field: 'taxes',
      message: cgst.length ? 'CGST without a matching SGST.' : 'SGST without a matching CGST.',
    });
  }
  if (igst.length > 0 && cgst.length + sgst.length > 0) {
    issues.push({ field: 'taxes', message: 'IGST appears together with CGST/SGST.' });
  }

  if (r.gstin !== null && !isValidGstin(r.gstin)) {
    issues.push({ field: 'gstin', message: `GSTIN ${r.gstin.slice(0, 20)} fails its checksum.` });
  }

  if (r.date !== null) {
    const tomorrow = new Date(Date.parse(`${r.today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (r.date > tomorrow) {
      issues.push({ field: 'date', message: `Receipt date ${r.date} is in the future.` });
    } else if (r.date < '2000-01-01') {
      issues.push({ field: 'date', message: `Receipt date ${r.date} looks wrong.` });
    } else if (r.dateRaw !== null && !rawDateMatches(r.dateRaw, r.date)) {
      issues.push({ field: 'date', message: `The date doesn't match what's printed.` });
    }
  }
  return issues;
}
