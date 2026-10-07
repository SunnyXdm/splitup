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
 * and sessions directly, and drives the personal group archive over HTTP.
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

async function archivedAt(who: string, groupId: number): Promise<string | null | undefined> {
  const { data } = await call(who, 'GET', '/api/sync');
  return data.groups.find((g: { id: number }) => g.id === groupId)?.archivedAt;
}

async function archiveAll(groupId: number, who: string[]): Promise<void> {
  for (const w of who) {
    assert.equal((await call(w, 'PUT', `/api/groups/${groupId}/archive`)).status, 200);
  }
}

/** An expense of `cents` paid by `payer`, split evenly across `split`. */
function expense(groupId: number, payer: string, split: string[], cents: number) {
  const each = cents / split.length;
  const people = new Set([payer, ...split]);
  return {
    groupId,
    description: 'Dinner',
    amountCents: cents,
    currency: 'INR',
    date: '2026-10-07',
    category: 'general',
    notes: null,
    isPayment: false,
    shares: [...people].map((p) => ({
      userId: id(p),
      paidCents: p === payer ? cents : 0,
      owedCents: split.includes(p) ? each : 0,
    })),
  };
}

let trip: number;
let flat: number;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-archive-'));
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
  for (const n of ['Asha', 'Bilal', 'Chen', 'Dev', 'Esi']) addUser(n);
  befriend('Asha', 'Bilal');
  trip = addGroup('Goa', ['Asha', 'Bilal', 'Chen', 'Dev', 'Esi']);
  flat = addGroup('Flat', ['Asha', 'Bilal']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('PUT/DELETE /api/groups/:id/archive', () => {
  it('404s for non-members and unknown groups, 401s without a session', async () => {
    assert.equal((await call('Chen', 'PUT', `/api/groups/${flat}/archive`)).status, 404);
    assert.equal((await call('Chen', 'DELETE', `/api/groups/${flat}/archive`)).status, 404);
    assert.equal((await call('Asha', 'PUT', '/api/groups/999999/archive')).status, 404);
    const anon = await fetch(`${base}/api/groups/${flat}/archive`, {
      method: 'PUT',
      headers: { 'x-csrf': '1' },
    });
    assert.equal(anon.status, 401);
  });

  it('archives for me only, and keeps the group in sync', async () => {
    assert.equal(await archivedAt('Asha', flat), null);
    const res = await call('Asha', 'PUT', `/api/groups/${flat}/archive`);
    assert.equal(res.status, 200);
    assert.equal(res.data.id, flat);
    assert.equal(typeof res.data.archivedAt, 'string');
    assert.equal(await archivedAt('Asha', flat), res.data.archivedAt);
    // Another member's view is untouched.
    assert.equal(await archivedAt('Bilal', flat), null);
  });

  it('is idempotent and keeps the original timestamp', async () => {
    const first = await archivedAt('Asha', flat);
    const again = await call('Asha', 'PUT', `/api/groups/${flat}/archive`);
    assert.equal(again.status, 200);
    assert.equal(again.data.archivedAt, first);
  });

  it('archived groups stay in every balance: their expenses still sync', async () => {
    const rent = expense(flat, 'Bilal', ['Bilal'], 500);
    const add = await call('Bilal', 'POST', '/api/expenses', rent);
    assert.equal(add.status, 200);
    const { data } = await call('Asha', 'GET', '/api/sync');
    assert.ok(data.expenses.some((e: { id: number }) => e.id === add.data.id));
    // Asha took no part and her net stays zero: still archived.
    assert.notEqual(await archivedAt('Asha', flat), null);
  });

  it('unarchives', async () => {
    const res = await call('Asha', 'DELETE', `/api/groups/${flat}/archive`);
    assert.equal(res.status, 200);
    assert.equal(res.data.archivedAt, null);
    assert.equal(await archivedAt('Asha', flat), null);
    // Unarchiving a group that isn't archived is a no-op.
    assert.equal((await call('Asha', 'DELETE', `/api/groups/${flat}/archive`)).status, 200);
  });
});

describe('auto-unarchive on new activity', () => {
  it('unarchives share participants of a new expense, nobody else', async () => {
    await archiveAll(trip, ['Asha', 'Bilal', 'Chen', 'Dev', 'Esi']);
    const dinner = expense(trip, 'Asha', ['Asha', 'Bilal'], 300);
    const res = await call('Asha', 'POST', '/api/expenses', dinner);
    assert.equal(res.status, 200);
    assert.equal(await archivedAt('Asha', trip), null);
    assert.equal(await archivedAt('Bilal', trip), null);
    for (const who of ['Chen', 'Dev', 'Esi']) assert.notEqual(await archivedAt(who, trip), null);
  });

  it('unarchives members whose group net is nonzero after the write', async () => {
    // Dev pays for Chen: both participate, both come back.
    const res = await call('Dev', 'POST', '/api/expenses', expense(trip, 'Dev', ['Chen'], 200));
    assert.equal(res.status, 200);
    assert.equal(await archivedAt('Chen', trip), null);
    assert.equal(await archivedAt('Dev', trip), null);
    // Chen and Dev archive again despite their open balance; an unrelated
    // expense brings them back because their net is still nonzero. Esi (net
    // zero, not a participant) stays archived.
    await archiveAll(trip, ['Chen', 'Dev']);
    const solo = expense(trip, 'Bilal', ['Bilal'], 100);
    const other = await call('Bilal', 'POST', '/api/expenses', solo);
    assert.equal(other.status, 200);
    assert.equal(await archivedAt('Chen', trip), null);
    assert.equal(await archivedAt('Dev', trip), null);
    assert.notEqual(await archivedAt('Esi', trip), null);
  });

  it('edits apply the same rule', async () => {
    await archiveAll(trip, ['Asha', 'Bilal']);
    const { data } = await call('Asha', 'GET', '/api/sync');
    const dinner = data.expenses.find(
      (e: { groupId: number; amountCents: number }) => e.groupId === trip && e.amountCents === 300,
    );
    const res = await call('Asha', 'PATCH', `/api/expenses/${dinner.id}`, {
      ...expense(trip, 'Asha', ['Asha', 'Bilal'], 400),
      expectedUpdatedAt: dinner.updatedAt,
    });
    assert.equal(res.status, 200);
    assert.equal(await archivedAt('Asha', trip), null);
    assert.equal(await archivedAt('Bilal', trip), null);
    assert.notEqual(await archivedAt('Esi', trip), null);
  });

  it('settle-ups unarchive the two people involved only', async () => {
    await archiveAll(trip, ['Asha', 'Bilal']);
    const res = await call('Bilal', 'POST', '/api/settlements', {
      counterpartyId: id('Asha'),
      currency: 'INR',
      date: '2026-10-07',
      rows: [{ groupId: trip, payerId: id('Bilal'), recipientId: id('Asha'), amountCents: 200 }],
    });
    assert.equal(res.status, 200);
    assert.equal(await archivedAt('Asha', trip), null);
    assert.equal(await archivedAt('Bilal', trip), null);
    assert.notEqual(await archivedAt('Esi', trip), null);
  });

  it('leaving a group drops my archive, so a later re-join starts unarchived', async () => {
    assert.equal((await call('Esi', 'POST', `/api/groups/${trip}/leave`)).status, 204);
    const n = seed
      .prepare('SELECT COUNT(*) AS n FROM group_prefs WHERE group_id = ? AND user_id = ?')
      .get(trip, id('Esi')) as { n: number };
    assert.equal(n.n, 0);
  });
});
