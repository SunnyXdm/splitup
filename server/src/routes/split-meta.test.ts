import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * End-to-end: split descriptions (Expense.split) are validated against the
 * shares, stored and returned, replaced by edits, cleared by an edit without
 * one and by restores.
 */

const SERVER_DIR = path.join(import.meta.dirname, '..', '..');
let dir: string;
let child: ChildProcess;
let base: string;
let seed: Database.Database;

const tokens = new Map<string, string>();
const ids = new Map<string, number>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${base}/api/sync`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('server did not start');
}

async function call(
  who: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      cookie: `splitup_session=${tokens.get(who)}`,
      'x-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const now = () => new Date().toISOString();

function addUser(name: string): void {
  const id = Number(
    seed
      .prepare(
        "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES (?, ?, ?, 'INR', ?)",
      )
      .run(`sub-${name}`, `${name.toLowerCase()}@example.com`, name, now()).lastInsertRowid,
  );
  const token = randomBytes(32).toString('hex');
  seed
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      id,
      now(),
      new Date(Date.now() + 86_400_000).toISOString(),
    );
  ids.set(name, id);
  tokens.set(name, token);
}

function addGroup(name: string, members: string[]): number {
  const gid = Number(
    seed
      .prepare(
        "INSERT INTO groups (name, currency, created_by, created_at) VALUES (?, 'INR', ?, ?)",
      )
      .run(name, ids.get(members[0]), now()).lastInsertRowid,
  );
  for (const m of members) {
    seed
      .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(gid, ids.get(m), now());
  }
  return gid;
}

const id = (name: string) => ids.get(name)!;

let goa: number;

type Share = { userId: number; paidCents: number; owedCents: number };

const fields = (over: Record<string, unknown> = {}) => ({
  groupId: goa,
  description: 'Dinner',
  amountCents: 1000,
  currency: 'INR',
  date: '2026-10-01',
  category: 'food',
  notes: null,
  isPayment: false,
  ...over,
});

/** Asha paid it all; owed amounts by name. */
const sharesFor = (amount: number, owed: Record<string, number>): Share[] =>
  Object.entries(owed).map(([name, owedCents]) => ({
    userId: id(name),
    paidCents: name === 'Asha' ? amount : 0,
    owedCents,
  }));

const values = (v: Record<string, number>) =>
  Object.fromEntries(Object.entries(v).map(([name, n]) => [String(id(name)), n]));

const create = (body: Record<string, unknown>) => call('Asha', 'POST', '/api/expenses', body);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-split-meta-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DB_PATH: path.join(dir, 'test.db'),
      PORT: String(port),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer();
  seed = new Database(path.join(dir, 'test.db'));
  seed.pragma('busy_timeout = 5000');
  for (const n of ['Asha', 'Bilal', 'Chen']) addUser(n);
  goa = addGroup('Goa', ['Asha', 'Bilal', 'Chen']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('expense split descriptions', () => {
  it('stores an equal split and returns it on the expense and in sync', async () => {
    // 1000 / 3 → the extra cent goes to the lowest id (Asha).
    const split = { mode: 'equal', participants: [id('Chen'), id('Asha'), id('Bilal')] };
    const res = await create(
      fields({ shares: sharesFor(1000, { Asha: 334, Bilal: 333, Chen: 333 }), split }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.split, split);
    const sync = await call('Bilal', 'GET', '/api/sync');
    const row = sync.data.expenses.find((e: any) => e.id === res.data.id);
    assert.deepEqual(row.split, split);
  });

  it('round-trips percent, shares and unequal splits', async () => {
    const cases: { split: Record<string, unknown>; owed: Record<string, number> }[] = [
      {
        split: {
          mode: 'percent',
          participants: [id('Asha'), id('Bilal')],
          values: values({ Asha: 3333, Bilal: 6667 }),
        },
        owed: { Asha: 333, Bilal: 667 },
      },
      {
        split: {
          mode: 'shares',
          participants: [id('Asha'), id('Chen')],
          values: values({ Asha: 1, Chen: 3 }),
        },
        owed: { Asha: 250, Chen: 750 },
      },
      {
        split: {
          mode: 'unequal',
          participants: [id('Bilal'), id('Chen')],
          values: values({ Bilal: 400, Chen: 600 }),
        },
        owed: { Asha: 0, Bilal: 400, Chen: 600 },
      },
    ];
    for (const c of cases) {
      const res = await create(fields({ shares: sharesFor(1000, c.owed), split: c.split }));
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data.split, c.split);
    }
  });

  it('rejects a split that disagrees with the shares', async () => {
    const all = [id('Asha'), id('Bilal'), id('Chen')];
    const bad = [
      // Equal between two, but three are charged.
      { mode: 'equal', participants: [id('Asha'), id('Bilal')] },
      // Percentages that don't reach 100.
      {
        mode: 'percent',
        participants: all,
        values: values({ Asha: 3000, Bilal: 3000, Chen: 3000 }),
      },
      // A value for someone outside the split.
      { mode: 'shares', participants: [id('Asha')], values: values({ Asha: 1, Bilal: 1 }) },
      // Equal takes no values.
      { mode: 'equal', participants: all, values: values({ Asha: 1 }) },
      // Exact amounts that don't match.
      { mode: 'unequal', participants: all, values: values({ Asha: 300, Bilal: 300, Chen: 400 }) },
      // Someone in the split who holds no share.
      { mode: 'equal', participants: [...all, 999] },
    ];
    for (const split of bad) {
      const res = await create(
        fields({ shares: sharesFor(1000, { Asha: 334, Bilal: 333, Chen: 333 }), split }),
      );
      assert.equal(res.status, 400, JSON.stringify(split));
    }
    const payment = await create(
      fields({
        isPayment: true,
        shares: [
          { userId: id('Asha'), paidCents: 1000, owedCents: 0 },
          { userId: id('Bilal'), paidCents: 0, owedCents: 1000 },
        ],
        split: { mode: 'unequal', participants: [id('Bilal')], values: values({ Bilal: 1000 }) },
      }),
    );
    assert.equal(payment.status, 400);
  });

  it('is replaced by edits, cleared by an edit without one and by a restore', async () => {
    const equal = { mode: 'equal', participants: [id('Asha'), id('Bilal')] };
    const created = await create(
      fields({ shares: sharesFor(1000, { Asha: 500, Bilal: 500 }), split: equal }),
    );
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const e = created.data;
    const patch = (from: any, over: Record<string, unknown>) =>
      call('Bilal', 'PATCH', `/api/expenses/${e.id}`, {
        ...fields(),
        shares: from.shares,
        expectedUpdatedAt: from.updatedAt,
        ...over,
      });

    const byShares = {
      mode: 'shares',
      participants: [id('Asha'), id('Bilal')],
      values: values({ Asha: 1, Bilal: 4 }),
    };
    const edited = await patch(e, {
      shares: sharesFor(1000, { Asha: 200, Bilal: 800 }),
      split: byShares,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.deepEqual(edited.data.split, byShares);

    const bare = await patch(edited.data, { description: 'Dinner (edited)' });
    assert.equal(bare.status, 200, JSON.stringify(bare.data));
    assert.equal(bare.data.split, undefined);

    // Back to revision 1 (the equal split): restored shares carry no description.
    const restored = await call('Asha', 'POST', `/api/expenses/${e.id}/restore`, {
      revision: 1,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.split, undefined);
    assert.deepEqual(
      restored.data.shares.map((s: Share) => s.owedCents),
      [500, 500],
    );
  });
});
