import { CATEGORY_META } from './categories';
import { formatDateSafe } from './dates';
import { formatMoney } from './money';
import type { ExpenseRevision, ExpenseShare, ExpenseSnapshot } from './types';

/**
 * Human wording for an expense's revision history: what changed between two
 * consecutive snapshots ("amount ₹400 → ₹450, split, date") plus one line per
 * person whose share moved. Pure — names come in through `nameOf`.
 */

export interface SnapshotDiff {
  /** Headline fragments, in a fixed reading order. */
  parts: string[];
  /** Per-person split lines ("Bilal ₹200 → ₹250", "Chen added (₹100)"). */
  splitLines: string[];
}

type NameOf = (userId: number) => string;

const shortDate = (date: string) => formatDateSafe(date, 'MMM d, yyyy', date);

/** "Asha", "Asha & Bilal", "Asha, Bilal & Chen"; "nobody" when empty. */
export function joinNames(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Who paid, by name; with amounts when several people chipped in. */
function payerText(s: ExpenseSnapshot, nameOf: NameOf): string {
  const payers = s.shares.filter((x) => x.paidCents > 0).sort((a, b) => a.userId - b.userId);
  if (payers.length <= 1) return joinNames(payers.map((p) => nameOf(p.userId)));
  return joinNames(
    payers.map((p) => `${nameOf(p.userId)} ${formatMoney(p.paidCents, s.currency)}`),
  );
}

const owedBy = (shares: ExpenseShare[]) =>
  new Map(shares.filter((x) => x.owedCents > 0).map((x) => [x.userId, x.owedCents]));

/** Differences from `prev` to `next`, worded for people. Empty when identical. */
export function diffSnapshots(
  prev: ExpenseSnapshot,
  next: ExpenseSnapshot,
  nameOf: NameOf,
): SnapshotDiff {
  const parts: string[] = [];
  const currencyChanged = prev.currency !== next.currency;
  if (prev.amountCents !== next.amountCents || currencyChanged) {
    parts.push(
      `amount ${formatMoney(prev.amountCents, prev.currency)} → ${formatMoney(
        next.amountCents,
        next.currency,
      )}`,
    );
  }
  if (prev.description !== next.description && !(prev.isPayment && next.isPayment)) {
    parts.push(`description “${prev.description}” → “${next.description}”`);
  }

  const prevPayers = payerText(prev, nameOf);
  const nextPayers = payerText(next, nameOf);
  if (prevPayers !== nextPayers) parts.push(`paid by ${prevPayers} → ${nextPayers}`);

  const before = owedBy(prev.shares);
  const after = owedBy(next.shares);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const splitLines: string[] = [];
  for (const uid of ids) {
    const a = before.get(uid);
    const b = after.get(uid);
    if (a === b && !currencyChanged) continue;
    if (a === undefined) {
      splitLines.push(`${nameOf(uid)} added (${formatMoney(b!, next.currency)})`);
    } else if (b === undefined) {
      splitLines.push(`${nameOf(uid)} removed (was ${formatMoney(a, prev.currency)})`);
    } else {
      splitLines.push(
        `${nameOf(uid)} ${formatMoney(a, prev.currency)} → ${formatMoney(b, next.currency)}`,
      );
    }
  }
  if (splitLines.length > 0) parts.push('split');

  if (prev.date !== next.date) {
    parts.push(`date ${shortDate(prev.date)} → ${shortDate(next.date)}`);
  }
  if (prev.category !== next.category) {
    const label = (c: string) => CATEGORY_META[c as keyof typeof CATEGORY_META]?.label ?? c;
    parts.push(`category ${label(prev.category)} → ${label(next.category)}`);
  }
  if ((prev.notes ?? '') !== (next.notes ?? '')) {
    parts.push(!prev.notes ? 'added notes' : !next.notes ? 'removed notes' : 'notes');
  }
  return { parts, splitLines };
}

export interface RevisionLine {
  revision: number;
  /** "Asha changed amount ₹400 → ₹450, split, date" */
  title: string;
  splitLines: string[];
  actorId: number;
  createdAt: string;
  /** Older revisions that differ from the current state can be restored. */
  restorable: boolean;
}

/**
 * One line per revision (input and output newest first). `current` is the
 * live state (null when the expense is deleted): a revision equal to it has
 * nothing to restore — except a deleted expense, where any version does.
 */
export function describeRevisions(
  revisions: ExpenseRevision[],
  nameOf: NameOf,
  current: ExpenseSnapshot | null,
): RevisionLine[] {
  return revisions.map((rev, i) => {
    const prev = revisions[i + 1];
    const who = nameOf(rev.actorId);
    const diff = prev ? diffSnapshots(prev.snapshot, rev.snapshot, nameOf) : null;
    let title: string;
    if (rev.action === 'created') {
      const { amountCents, currency } = rev.snapshot;
      title = `${who} added this for ${formatMoney(amountCents, currency)}`;
    } else if (rev.action === 'deleted') {
      title = `${who} deleted this`;
    } else if (rev.action === 'restored') {
      title =
        diff && diff.parts.length > 0
          ? `${who} restored an earlier version: ${diff.parts.join(', ')}`
          : `${who} restored this`;
    } else {
      title =
        diff && diff.parts.length > 0
          ? `${who} changed ${diff.parts.join(', ')}`
          : `${who} saved without changes`;
    }
    return {
      revision: rev.revision,
      title,
      splitLines:
        rev.action === 'created' || rev.action === 'deleted' ? [] : (diff?.splitLines ?? []),
      actorId: rev.actorId,
      createdAt: rev.createdAt,
      restorable: current === null || !sameSnapshot(rev.snapshot, current),
    };
  });
}

/** Same user-facing state (share order and blank notes don't matter). */
export function sameSnapshot(a: ExpenseSnapshot, b: ExpenseSnapshot): boolean {
  const norm = (s: ExpenseSnapshot) =>
    JSON.stringify([
      s.description,
      s.amountCents,
      s.currency,
      s.date,
      s.category,
      s.notes || null,
      s.groupId,
      s.isPayment,
      [...s.shares]
        .sort((x, y) => x.userId - y.userId)
        .map((x) => [x.userId, x.paidCents, x.owedCents]),
    ]);
  return norm(a) === norm(b);
}

/** The snapshot of a live expense, for comparing against its history. */
export function snapshotOf(e: ExpenseSnapshot): ExpenseSnapshot {
  return {
    description: e.description,
    amountCents: e.amountCents,
    currency: e.currency,
    date: e.date,
    category: e.category,
    notes: e.notes,
    groupId: e.groupId,
    isPayment: e.isPayment,
    shares: e.shares.map((s) => ({
      userId: s.userId,
      paidCents: s.paidCents,
      owedCents: s.owedCents,
    })),
  };
}
