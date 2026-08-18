#!/usr/bin/env node
/**
 * One-time migration: decompose historical cross-scope settlement payments.
 *
 * Friends-tab settles used to record ONE non-group payment for the cross-group
 * net, which group ledgers never see (they read only their own expenses). For
 * each pair of users, this script takes the net cash their non-group payments
 * actually moved and decomposes it against TODAY's routed edges — the same
 * decomposition the fixed app now records at settle time. Present-state (not
 * historical-replay) decomposition is deliberate: replaying against historical
 * routings produces group rows that reshape today's routing and shift edges
 * between bystander pairs; decomposing against today's edges cancels them
 * exactly, which is what keeps every pair balance identical (invariant V2).
 *
 * Usage:
 *   node migrate-cross-scope-payments.cjs <db-path>          # dry-run (read-only)
 *   node migrate-cross-scope-payments.cjs <db-path> --apply  # write replacements
 *
 * Replacements keep the original's date/created_at/created_by (new ids, notes
 * "migrated from #<id>"); originals are soft-deleted. Original activity rows
 * stay untouched — their denormalized summaries remain true.
 */
'use strict';

const path = require('node:path');
const Database = require(
  require('node:fs').existsSync('/app/server/node_modules/better-sqlite3')
    ? '/app/server/node_modules/better-sqlite3'
    : path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
);

const dbPath = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!dbPath) {
  console.error('usage: migrate-cross-scope-payments.cjs <db-path> [--apply]');
  process.exit(1);
}
const db = new Database(dbPath, { readonly: !APPLY });
// Apply mode: hold one immediate transaction across plan, writes, AND
// verification, so a concurrently running app can neither invalidate the plan
// after it's computed nor observe a half-applied state; verification failure
// rolls everything back.
if (APPLY) db.exec('BEGIN IMMEDIATE');

// ---------------------------------------------------------------------------
// Engine — faithful ports of web/src/lib/balances.ts + settle.ts over plain
// {id, groupId, currency, createdAt, isPayment, shares} rows.
// ---------------------------------------------------------------------------

function groupNets(expenses, groupId) {
  const byCurrency = new Map();
  for (const e of expenses) {
    if (e.groupId !== groupId) continue;
    let byUser = byCurrency.get(e.currency);
    if (!byUser) byCurrency.set(e.currency, (byUser = new Map()));
    for (const s of e.shares) {
      byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + s.paidCents - s.owedCents);
    }
  }
  const out = [];
  for (const currency of [...byCurrency.keys()].sort()) {
    for (const [userId, net] of byCurrency.get(currency)) {
      if (net !== 0) out.push({ userId, net, currency });
    }
  }
  return out;
}

function takeLargest(entries) {
  let best = entries[0];
  for (const e of entries) {
    if (e.cents > best.cents || (e.cents === best.cents && e.userId < best.userId)) best = e;
  }
  return best;
}

function suggestSettlements(nets) {
  const byCurrency = new Map();
  for (const b of nets) {
    if (!byCurrency.has(b.currency)) byCurrency.set(b.currency, []);
    byCurrency.get(b.currency).push(b);
  }
  const transfers = [];
  for (const currency of [...byCurrency.keys()].sort()) {
    const creditors = [];
    const debtors = [];
    for (const b of byCurrency.get(currency)) {
      if (b.net > 0) creditors.push({ userId: b.userId, cents: b.net });
      else if (b.net < 0) debtors.push({ userId: b.userId, cents: -b.net });
    }
    while (creditors.length > 0 && debtors.length > 0) {
      const d = takeLargest(debtors);
      const cr = takeLargest(creditors);
      const cents = Math.min(d.cents, cr.cents);
      transfers.push({ fromUserId: d.userId, toUserId: cr.userId, cents, currency });
      d.cents -= cents;
      cr.cents -= cents;
      if (d.cents === 0) debtors.splice(debtors.indexOf(d), 1);
      if (cr.cents === 0) creditors.splice(creditors.indexOf(cr), 1);
    }
  }
  return transfers;
}

/** Non-group 2-person pairwise net for `a` vs `b` (+ = b owes a). */
function directNet(expenses, a, b, currency) {
  let net = 0;
  for (const e of expenses) {
    if (e.groupId !== null || e.currency !== currency || e.shares.length !== 2) continue;
    const sa = e.shares.find((s) => s.userId === a);
    if (!sa || !e.shares.some((s) => s.userId === b)) continue;
    // Two-person expense: a's net IS the pair net (the shares sum to zero).
    net += sa.paidCents - sa.owedCents;
  }
  return net;
}

/** Constituents of `friend`'s balance with `me` (+ = friend owes me). */
function pairConstituents(expenses, liveGroupIds, meId, friendId, currency) {
  const out = [];
  for (const gid of liveGroupIds) {
    for (const t of suggestSettlements(groupNets(expenses, gid))) {
      if (t.currency !== currency) continue;
      if (t.fromUserId === friendId && t.toUserId === meId) out.push({ scope: gid, cents: t.cents });
      else if (t.fromUserId === meId && t.toUserId === friendId)
        out.push({ scope: gid, cents: -t.cents });
    }
  }
  const direct = directNet(expenses, meId, friendId, currency);
  if (direct !== 0) out.push({ scope: null, cents: direct });
  return out;
}

/**
 * Port of apportionSettle for the payer→recipient ('they_paid') direction,
 * with one migration-specific addition: a partial amount that exactly matches
 * a single edge lands on that edge (a historical payment sized to one group's
 * suggestion should settle that group, not the largest debt).
 */
function apportion(constituents, amountCents, meId, friendId) {
  const row = (scope, cents, counter) => ({
    groupId: scope,
    payerId: cents > 0 ? friendId : meId,
    recipientId: cents > 0 ? meId : friendId,
    amountCents: Math.abs(cents),
    counter,
  });
  const same = constituents.filter((c) => c.cents > 0);
  const opposing = constituents.filter((c) => c.cents < 0);
  const net = constituents.reduce((sum, c) => sum + c.cents, 0);

  if (net <= 0) return [row(null, amountCents, false)];
  if (amountCents >= net) {
    // Merge overpay excess into an existing same-direction direct slice so no
    // pair ever ends up with two direct rows in one direction.
    const excess = amountCents - net;
    const rows = [];
    let excessUsed = false;
    for (const c of same) {
      if (c.scope === null && excess > 0) {
        rows.push(row(null, c.cents + excess, false));
        excessUsed = true;
      } else {
        rows.push(row(c.scope, c.cents, false));
      }
    }
    for (const c of opposing) rows.push(row(c.scope, c.cents, true));
    if (excess > 0 && !excessUsed) rows.push(row(null, excess, false));
    return rows;
  }
  const exact = same.find((c) => c.cents === amountCents);
  if (exact) return [row(exact.scope, amountCents, false)];
  const ordered = [...same].sort((a, b) => {
    const diff = b.cents - a.cents;
    if (diff !== 0) return diff;
    if (a.scope === null) return -1;
    if (b.scope === null) return 1;
    return a.scope - b.scope;
  });
  const rows = [];
  let remaining = amountCents;
  for (const c of ordered) {
    if (remaining === 0) break;
    const take = Math.min(remaining, c.cents);
    rows.push(row(c.scope, take, false));
    remaining -= take;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Load current truth
// ---------------------------------------------------------------------------

const users = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
const name = (id) => users.get(id) ?? `#${id}`;
const fmt = (c) => (c / 100).toFixed(2);

const liveGroups = db.prepare('SELECT id, name FROM groups WHERE deleted_at IS NULL').all();
const liveGroupIds = liveGroups.map((g) => g.id);
const groupName = new Map(liveGroups.map((g) => [g.id, g.name]));

const shareStmt = db.prepare(
  'SELECT user_id, paid_cents, owed_cents FROM expense_shares WHERE expense_id = ? ORDER BY user_id',
);
function loadExpenses() {
  return db
    .prepare(
      `SELECT id, group_id, currency, date, category, notes, is_payment, created_by, created_at
       FROM expenses WHERE deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      groupId: r.group_id,
      currency: r.currency,
      date: r.date,
      category: r.category,
      notes: r.notes,
      isPayment: r.is_payment === 1,
      createdBy: r.created_by,
      createdAt: r.created_at,
      shares: shareStmt.all(r.id).map((s) => ({
        userId: s.user_id,
        paidCents: s.paid_cents,
        owedCents: s.owed_cents,
      })),
    }));
}

// ---------------------------------------------------------------------------
// Present-state decomposition, one pair at a time
// ---------------------------------------------------------------------------

const original = loadExpenses();

// Group every non-group payment by unordered pair + currency.
const byPair = new Map(); // "a|b|currency" (a<b) -> payment rows
for (const e of original) {
  if (e.groupId !== null || !e.isPayment || e.shares.length !== 2) continue;
  const [x, y] = e.shares.map((s) => s.userId).sort((p, q) => p - q);
  const key = `${x}|${y}|${e.currency}`;
  if (!byPair.has(key)) byPair.set(key, []);
  byPair.get(key).push(e);
}

// All decompositions are computed against the SAME pre-state (today's edges,
// with every non-group payment set aside), then applied simultaneously. For
// settled pairs the rows cancel whole current edges, so the residual routing
// is exactly the genuine remaining debts — verified by V2 below.
const nonPaymentLedger = original.filter(
  (e) => !(e.groupId === null && e.isPayment && e.shares.length === 2),
);

let working = [...original];
const plan = []; // { originals, replacements }
let syntheticId = -1;

for (const [key, payments] of byPair) {
  const [a, b, currency] = key.split('|');
  const A = Number(a);
  const B = Number(b);
  // Net cash across the pair's payments, oriented A→B.
  let cash = 0;
  for (const p of payments) {
    const payer = p.shares.find((s) => s.paidCents > 0);
    cash += payer.userId === A ? payer.paidCents : -payer.paidCents;
  }
  const label = payments.map((p) => `#${p.id}`).join('+');
  if (cash === 0) {
    console.log(`${label} ${name(A)} ↔ ${name(B)}: payments net to zero, kept as-is`);
    continue;
  }
  const payerId = cash > 0 ? A : B;
  const recipientId = cash > 0 ? B : A;
  const amount = Math.abs(cash);

  const constituents = pairConstituents(
    nonPaymentLedger,
    liveGroupIds,
    recipientId,
    payerId,
    currency,
  );
  const rows = apportion(constituents, amount, recipientId, payerId);

  const isNoop =
    rows.length === 1 &&
    rows[0].groupId === null &&
    payments.length === 1 &&
    rows[0].payerId === payerId &&
    rows[0].amountCents === amount;
  if (isNoop) {
    console.log(`${label} ${name(payerId)} → ${name(recipientId)} ${fmt(amount)}: legitimately direct, kept as-is`);
    continue;
  }

  console.log(`${label} ${name(payerId)} → ${name(recipientId)} net ${fmt(amount)} decomposes into:`);
  for (const r of rows) {
    console.log(
      `    ${r.groupId === null ? 'direct' : (groupName.get(r.groupId) ?? r.groupId)}: ` +
        `${name(r.payerId)} → ${name(r.recipientId)} ${fmt(r.amountCents)}${r.counter ? ' (counter)' : ''}`,
    );
  }
  // Per-pair conservation: signed pair-net of replacements == net cash.
  const signed = rows.reduce(
    (sum, r) => sum + (r.payerId === payerId ? r.amountCents : -r.amountCents),
    0,
  );
  if (signed !== amount) {
    console.error(`    FATAL: replacements net ${fmt(signed)} != original ${fmt(amount)}`);
    process.exit(1);
  }

  // Replacements carry the pair's most recent payment's provenance.
  const latest = payments[payments.length - 1];
  const replacements = rows.map((r) => ({
    id: syntheticId--,
    groupId: r.groupId,
    currency,
    date: latest.date,
    category: latest.category,
    notes: `migrated from ${label}`,
    isPayment: true,
    createdBy: latest.createdBy,
    createdAt: latest.createdAt,
    shares: [
      { userId: r.payerId, paidCents: r.amountCents, owedCents: 0 },
      { userId: r.recipientId, paidCents: 0, owedCents: r.amountCents },
    ],
  }));
  const originalIds = new Set(payments.map((p) => p.id));
  working = working.filter((e) => !originalIds.has(e.id));
  working.push(...replacements);
  plan.push({ originals: payments, replacements });
}

// ---------------------------------------------------------------------------
// Invariant verification over the final (as-of-now) ledgers
// ---------------------------------------------------------------------------

function totals(expenses) {
  // Per-user per-currency overall net: group nets + direct pairwise nets.
  const out = new Map(); // "user|currency" -> cents
  const add = (userId, currency, cents) => {
    const key = `${userId}|${currency}`;
    out.set(key, (out.get(key) ?? 0) + cents);
  };
  for (const gid of liveGroupIds) {
    for (const b of groupNets(expenses, gid)) add(b.userId, b.currency, b.net);
  }
  for (const e of expenses) {
    if (e.groupId !== null) continue;
    for (const s of e.shares) add(s.userId, e.currency, s.paidCents - s.owedCents);
  }
  return out;
}

function allPairBalances(expenses) {
  const out = new Map(); // "a|b|currency" -> cents (+ = b owes a), a < b
  const ids = [...users.keys()].sort((x, y) => x - y);
  const currencies = new Set(expenses.map((e) => e.currency));
  for (const currency of currencies) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const cents = pairConstituents(expenses, liveGroupIds, ids[i], ids[j], currency).reduce(
          (sum, c) => sum + c.cents,
          0,
        );
        if (cents !== 0) out.set(`${ids[i]}|${ids[j]}|${currency}`, cents);
      }
    }
  }
  return out;
}

function diffMaps(label, pre, post) {
  const keys = new Set([...pre.keys(), ...post.keys()]);
  let ok = true;
  for (const key of keys) {
    const a = pre.get(key) ?? 0;
    const b = post.get(key) ?? 0;
    if (a !== b) {
      console.error(`  ${label} MISMATCH ${key}: pre ${fmt(a)} post ${fmt(b)}`);
      ok = false;
    }
  }
  return ok;
}

console.log('\n--- invariants ---');
const v1 = diffMaps('V1 total', totals(original), totals(working));
console.log(`V1 per-user totals conserved: ${v1 ? 'PASS' : 'FAIL'}`);
const v2 = diffMaps('V2 pair', allPairBalances(original), allPairBalances(working));
console.log(`V2 all pair balances unchanged: ${v2 ? 'PASS' : 'FAIL'}`);

console.log('\nPost-migration group ledgers (nonzero nets only):');
for (const gid of liveGroupIds) {
  const nets = groupNets(working, gid);
  if (nets.length === 0) continue;
  console.log(
    `  ${groupName.get(gid)}: ` +
      nets.map((b) => `${name(b.userId)} ${fmt(b.net)} ${b.currency}`).join(', '),
  );
  for (const t of suggestSettlements(nets)) {
    console.log(`    suggests ${name(t.fromUserId)} → ${name(t.toUserId)} ${fmt(t.cents)}`);
  }
}

if (!v1 || !v2) {
  if (APPLY) db.exec('ROLLBACK');
  console.error('\nInvariant failure — aborting. Nothing was written.');
  process.exit(1);
}
if (plan.length === 0) {
  console.log('\nNothing to migrate.');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\nDry-run complete: ${plan.length} payments would be decomposed. Re-run with --apply.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const insertExpense = db.prepare(
  `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
     is_payment, created_by, created_at, updated_at)
   VALUES (?, 'Payment', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
);
const insertShare = db.prepare(
  'INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents) VALUES (?, ?, ?, ?)',
);
const softDelete = db.prepare('UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?');

// Inside the BEGIN IMMEDIATE opened at startup.
for (const { originals, replacements } of plan) {
  for (const r of replacements) {
    const info = insertExpense.run(
      r.groupId,
      r.shares[0].paidCents,
      r.currency,
      r.date,
      r.category,
      r.notes,
      r.createdBy,
      r.createdAt,
      now,
    );
    for (const s of r.shares) {
      insertShare.run(Number(info.lastInsertRowid), s.userId, s.paidCents, s.owedCents);
    }
  }
  for (const o of originals) softDelete.run(now, now, o.id);
}

const replaced = plan.reduce((n, p) => n + p.originals.length, 0);
console.log(`\nApplied: ${replaced} payments decomposed into ${plan.reduce((n, p) => n + p.replacements.length, 0)} rows; originals soft-deleted.`);

// Verify from the database BEFORE committing; any failure rolls back.
const applied = loadExpenses();
const v1b = diffMaps('V1b total', totals(original), totals(applied));
const v2b = diffMaps('V2b pair', allPairBalances(original), allPairBalances(applied));
console.log(`Post-apply verification: totals ${v1b ? 'PASS' : 'FAIL'}, pairs ${v2b ? 'PASS' : 'FAIL'}`);
if (v1b && v2b) {
  db.exec('COMMIT');
  process.exit(0);
} else {
  db.exec('ROLLBACK');
  console.error('Verification failed — ROLLED BACK, nothing was changed.');
  process.exit(1);
}
