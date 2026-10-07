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
 * End-to-end: boots the real server against a throwaway database, seeds users
 * and sessions directly, and drives /api/settlements over HTTP.
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

function befriend(a: string, b: string): void {
  const stmt = seed.prepare(
    'INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
  );
  stmt.run(ids.get(a), ids.get(b), now());
  stmt.run(ids.get(b), ids.get(a), now());
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
const liveCount = (expenseIds: number[]) =>
  (
    seed
      .prepare(
        `SELECT COUNT(*) AS n FROM expenses WHERE deleted_at IS NULL AND id IN (${expenseIds
          .map(() => '?')
          .join(',')})`,
      )
      .get(...expenseIds) as { n: number }
  ).n;

let g1: number;
let g2: number;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-settle-'));
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
  befriend('Asha', 'Bilal');
  befriend('Asha', 'Chen');
  g1 = addGroup('Goa', ['Asha', 'Bilal', 'Chen']);
  g2 = addGroup('Flat', ['Asha', 'Bilal']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/settlements batches', () => {
  let batchId: number;
  let rowIds: number[];
  const body = () => ({
    counterpartyId: id('Bilal'),
    currency: 'INR',
    date: '2026-10-07',
    clientKey: 'settle-key-0001',
    method: 'upi',
    reference: '  UPI-12345  ',
    note: 'Goa + rent',
    rows: [
      { groupId: g1, payerId: id('Asha'), recipientId: id('Bilal'), amountCents: 100_000 },
      { groupId: g2, payerId: id('Asha'), recipientId: id('Bilal'), amountCents: 40_000 },
      // counter row: offsets an opposing direct balance
      { groupId: null, payerId: id('Bilal'), recipientId: id('Asha'), amountCents: 20_000 },
    ],
  });

  it('records one batch with the net cash and links every row', async () => {
    const res = await call('Asha', 'POST', '/api/settlements', body());
    assert.equal(res.status, 200);
    const { expenses, batch } = res.data;
    assert.equal(expenses.length, 3);
    assert.equal(batch.payerId, id('Asha'));
    assert.equal(batch.payeeId, id('Bilal'));
    assert.equal(batch.amountCents, 120_000);
    assert.equal(batch.method, 'upi');
    assert.equal(batch.reference, 'UPI-12345');
    assert.equal(batch.note, 'Goa + rent');
    assert.equal(batch.createdBy, id('Asha'));
    rowIds = expenses.map((e: { id: number }) => e.id);
    assert.deepEqual(batch.rows, rowIds);
    for (const e of expenses) assert.equal(e.settlementBatchId, batch.id);
    batchId = batch.id;
  });

  it('replays the same clientKey to the same batch and rows', async () => {
    const res = await call('Asha', 'POST', '/api/settlements', body());
    assert.equal(res.status, 200);
    assert.equal(res.data.batch.id, batchId);
    assert.deepEqual(
      res.data.expenses.map((e: { id: number }) => e.id),
      rowIds,
    );
    const n = seed.prepare('SELECT COUNT(*) AS n FROM settlement_batches').get() as { n: number };
    assert.equal(n.n, 1);
  });

  it('syncs the batch to both participants, and to a co-member with only their rows', async () => {
    for (const who of ['Asha', 'Bilal']) {
      const { data } = await call(who, 'GET', '/api/sync');
      const b = data.settlementBatches.find((x: { id: number }) => x.id === batchId);
      assert.ok(b, `${who} sees the batch`);
      assert.deepEqual(b.rows, rowIds);
    }
    // Chen sees the Goa row (group member), so he gets the batch too — limited
    // to the rows he can see, for a read-only receipt.
    const { data } = await call('Chen', 'GET', '/api/sync');
    assert.ok(data.expenses.some((e: { id: number }) => e.id === rowIds[0]));
    const b = data.settlementBatches.find((x: { id: number }) => x.id === batchId);
    assert.ok(b, 'Chen sees the batch');
    assert.deepEqual(b.rows, [rowIds[0]]);
    assert.equal(b.payerId, id('Asha'));
  });

  it('keeps the stale-watermark 409', async () => {
    const res = await call('Asha', 'POST', '/api/settlements', {
      ...body(),
      clientKey: 'settle-key-0002',
      watermark: '2000-01-01T00:00:00.000Z',
      watermarkCount: 0,
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'stale');
  });

  it('rejects over-long details and rows that cancel out', async () => {
    const long = await call('Asha', 'POST', '/api/settlements', {
      ...body(),
      clientKey: undefined,
      reference: 'x'.repeat(101),
    });
    assert.equal(long.status, 400);
    const zero = await call('Asha', 'POST', '/api/settlements', {
      counterpartyId: id('Bilal'),
      currency: 'INR',
      date: '2026-10-07',
      rows: [
        { groupId: g1, payerId: id('Asha'), recipientId: id('Bilal'), amountCents: 500 },
        { groupId: g2, payerId: id('Bilal'), recipientId: id('Asha'), amountCents: 500 },
      ],
    });
    assert.equal(zero.status, 400);
  });

  it('404s an undo from a non-participant', async () => {
    const res = await call('Chen', 'DELETE', `/api/settlements/${batchId}`);
    assert.equal(res.status, 404);
    assert.equal(liveCount(rowIds), 3);
  });

  it('undoes every row atomically, logs one activity entry, then 404s', async () => {
    const res = await call('Bilal', 'DELETE', `/api/settlements/${batchId}`);
    assert.equal(res.status, 204);
    assert.equal(liveCount(rowIds), 0);
    const { data } = await call('Asha', 'GET', '/api/sync');
    assert.equal(
      data.settlementBatches.some((b: { id: number }) => b.id === batchId),
      false,
    );
    assert.equal(
      data.expenses.some((e: { id: number }) => rowIds.includes(e.id)),
      false,
    );
    const undone = data.activity.filter((a: { type: string }) => a.type === 'payment_undone');
    assert.equal(undone.length, 1);
    assert.match(undone[0].summary, /^Bilal undid a payment of .*1,200.* from Asha$/);
    const again = await call('Asha', 'DELETE', `/api/settlements/${batchId}`);
    assert.equal(again.status, 404);
  });
});

describe('DELETE /api/settlements guards', () => {
  const settleWithChen = async (key: string) => {
    const res = await call('Asha', 'POST', '/api/settlements', {
      counterpartyId: id('Chen'),
      currency: 'INR',
      date: '2026-10-07',
      clientKey: key,
      rows: [
        { groupId: null, payerId: id('Asha'), recipientId: id('Chen'), amountCents: 3_000 },
        { groupId: g1, payerId: id('Asha'), recipientId: id('Chen'), amountCents: 7_000 },
      ],
    });
    assert.equal(res.status, 200);
    return res.data as { batch: { id: number; rows: number[] } };
  };

  it('refuses (and changes nothing) when it would move a departed member', async () => {
    const { batch } = await settleWithChen('departed-0001');
    seed.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g1, id('Chen'));
    try {
      const res = await call('Asha', 'DELETE', `/api/settlements/${batch.id}`);
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'departed member');
      assert.equal(liveCount(batch.rows), 2, 'the direct row was not deleted either');
      const live = seed
        .prepare('SELECT deleted_at FROM settlement_batches WHERE id = ?')
        .get(batch.id) as { deleted_at: string | null };
      assert.equal(live.deleted_at, null);
    } finally {
      seed
        .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(g1, id('Chen'), now());
    }
    const ok = await call('Chen', 'DELETE', `/api/settlements/${batch.id}`);
    assert.equal(ok.status, 204);
  });

  it('refuses when one of the groups was deleted', async () => {
    const { batch } = await settleWithChen('deleted-g-0001');
    seed.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(now(), g1);
    const res = await call('Asha', 'DELETE', `/api/settlements/${batch.id}`);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'group deleted');
    assert.equal(liveCount(batch.rows), 2);
    seed.prepare('UPDATE groups SET deleted_at = NULL WHERE id = ?').run(g1);
  });
});
