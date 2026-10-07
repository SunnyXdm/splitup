import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * scripts/migrate-cross-scope-payments.cjs against a throwaway database built
 * with the server's own schema, plus the boot-time superseded backfill. The
 * db module opens DB_PATH on import, so set it first and import dynamically.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'splitup-migrate-'));
const DB_FILE = path.join(dir, 'migrate.db');
process.env.DB_PATH = DB_FILE;
const SCRIPT = path.join(
  import.meta.dirname,
  '..',
  '..',
  'scripts',
  'migrate-cross-scope-payments.cjs',
);

let dbMod: typeof import('../db');

before(async () => {
  dbMod = await import('../db');
});

after(() => {
  dbMod?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = '2026-09-01T10:00:00.000Z';

function user(name: string): number {
  return Number(
    dbMod.db
      .prepare(
        "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES (?, ?, ?, 'INR', ?)",
      )
      .run(`sub-${name}`, `${name}@example.com`, name, T).lastInsertRowid,
  );
}

function group(name: string, members: number[]): number {
  const gid = Number(
    dbMod.db
      .prepare("INSERT INTO groups (name, currency, created_by, created_at) VALUES (?, 'INR', ?, ?)")
      .run(name, members[0], T).lastInsertRowid,
  );
  for (const m of members) {
    dbMod.db
      .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(gid, m, T);
  }
  return gid;
}

function expense(
  groupId: number | null,
  shares: [number, number, number][],
  opts: { isPayment?: boolean; batchId?: number; notes?: string; deleted?: boolean } = {},
): number {
  const amount = shares.reduce((s, [, paid]) => s + paid, 0);
  const id = Number(
    dbMod.db
      .prepare(
        `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
           is_payment, created_by, created_at, updated_at, settlement_batch_id, deleted_at)
         VALUES (?, ?, ?, 'INR', '2026-09-01', 'general', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        opts.isPayment ? 'Payment' : 'Dinner',
        amount,
        opts.notes ?? null,
        opts.isPayment ? 1 : 0,
        shares[0][0],
        T,
        T,
        opts.batchId ?? null,
        opts.deleted ? T : null,
      ).lastInsertRowid,
  );
  for (const [uid, paid, owed] of shares) {
    dbMod.db
      .prepare(
        'INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents) VALUES (?, ?, ?, ?)',
      )
      .run(id, uid, paid, owed);
  }
  return id;
}

const run = (...args: string[]) => {
  const res = spawnSync(process.execPath, [SCRIPT, DB_FILE, ...args], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
};

interface Row {
  id: number;
  group_id: number | null;
  deleted_at: string | null;
  superseded_by: number | null;
  notes: string | null;
  created_by: number;
}
const rowOf = (id: number) =>
  dbMod.db.prepare<[number], Row>('SELECT * FROM expenses WHERE id = ?').get(id)!;
const count = () =>
  dbMod.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM expenses').get()!.n;

describe('migrate-cross-scope-payments', () => {
  let legacy: number;
  let batched: number;
  let departedPayment: number;
  let goa: number;

  it('plans only legacy payments, dry-run by default', () => {
    const asha = user('asha');
    const bilal = user('bilal');
    const chen = user('chen');
    const dev = user('dev');
    goa = group('Goa', [asha, bilal]);
    const flat = group('Flat', [asha, chen]);
    const club = group('Club', [asha, dev]);
    // Bilal owes Asha 500 in Goa; his legacy direct payment settled it.
    expense(goa, [
      [asha, 1_000, 500],
      [bilal, 0, 500],
    ]);
    legacy = expense(
      null,
      [
        [bilal, 500, 0],
        [asha, 0, 500],
      ],
      { isPayment: true },
    );
    // Chen owes Asha 300 in Flat, settled by a BATCHED direct row: not legacy.
    expense(flat, [
      [asha, 600, 300],
      [chen, 0, 300],
    ]);
    const batchId = Number(
      dbMod.db
        .prepare(
          `INSERT INTO settlement_batches (created_by, payer_id, payee_id, amount_cents, currency,
             date, created_at) VALUES (?, ?, ?, 300, 'INR', '2026-09-01', ?)`,
        )
        .run(chen, chen, asha, T).lastInsertRowid,
    );
    batched = expense(
      null,
      [
        [chen, 300, 0],
        [asha, 0, 300],
      ],
      { isPayment: true, batchId },
    );
    // Dev owes Asha 400 in Club but has left it: his payment must stay direct.
    expense(club, [
      [asha, 800, 400],
      [dev, 0, 400],
    ]);
    dbMod.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(club, dev);
    departedPayment = expense(
      null,
      [
        [dev, 400, 0],
        [asha, 0, 400],
      ],
      { isPayment: true },
    );

    const before = count();
    const dry = run();
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /Dry-run complete: 1 payments would be decomposed/);
    assert.match(dry.out, /left that group/);
    assert.doesNotMatch(dry.out, new RegExp(`#${batched}\\b`));
    assert.match(dry.out, /V2 all pair balances unchanged: PASS/);
    assert.equal(count(), before);
    assert.equal(rowOf(legacy).deleted_at, null);
  });

  it('applies, marks the original superseded, and records revisions', () => {
    const before = count();
    const res = run('--apply');
    assert.equal(res.status, 0, res.out);
    assert.equal(count(), before + 1);
    const original = rowOf(legacy);
    assert.ok(original.deleted_at);
    assert.ok(original.superseded_by);
    const replacement = rowOf(original.superseded_by!);
    assert.equal(replacement.group_id, goa);
    assert.equal(replacement.notes, `migrated from #${legacy}`);
    assert.equal(replacement.deleted_at, null);
    const revs = dbMod.db
      .prepare<[number, number], { expense_id: number; action: string; actor_id: number }>(
        'SELECT expense_id, action, actor_id FROM expense_revisions WHERE expense_id IN (?, ?) ORDER BY id',
      )
      .all(legacy, replacement.id);
    assert.deepEqual(
      revs.map((r) => [r.expense_id, r.action, r.actor_id]),
      [
        [replacement.id, 'created', replacement.created_by],
        [legacy, 'deleted', replacement.created_by],
      ],
    );
    assert.equal(rowOf(batched).deleted_at, null);
    assert.equal(rowOf(departedPayment).deleted_at, null);
  });

  it('is idempotent', () => {
    const before = count();
    const res = run('--apply');
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /Nothing to migrate/);
    assert.equal(count(), before);
  });
});

describe('backfillSuperseded', () => {
  it('marks originals named by a replacement, once', () => {
    const { db, backfillSuperseded, migratedFromIds } = dbMod;
    assert.deepEqual(migratedFromIds('migrated from #12+#13'), [12, 13]);
    assert.deepEqual(migratedFromIds('migrated from #12 and more'), []);
    assert.deepEqual(migratedFromIds(null), []);
    const a = user('erin');
    const b = user('farah');
    const o1 = expense(
      null,
      [
        [a, 100, 0],
        [b, 0, 100],
      ],
      { isPayment: true, deleted: true },
    );
    const o2 = expense(
      null,
      [
        [b, 50, 0],
        [a, 0, 50],
      ],
      { isPayment: true, deleted: true },
    );
    const live = expense(
      null,
      [
        [a, 50, 0],
        [b, 0, 50],
      ],
      { isPayment: true },
    );
    const rep = expense(
      null,
      [
        [a, 50, 0],
        [b, 0, 50],
      ],
      { isPayment: true, notes: `migrated from #${o1}+#${o2}+#${live}` },
    );
    backfillSuperseded();
    assert.equal(rowOf(o1).superseded_by, rep);
    assert.equal(rowOf(o2).superseded_by, rep);
    assert.equal(rowOf(live).superseded_by, null, 'live rows are never marked');
    db.prepare('UPDATE expenses SET superseded_by = NULL WHERE id = ?').run(o2);
    backfillSuperseded();
    assert.equal(rowOf(o2).superseded_by, rep);
  });
});
