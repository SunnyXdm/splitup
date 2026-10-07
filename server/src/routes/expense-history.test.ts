import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';

/**
 * End-to-end: boots the real server against a throwaway database, seeds users
 * and sessions directly, and drives expense history + restore over HTTP.
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

let goa: number;

type Share = { userId: number; paidCents: number; owedCents: number };

/** Even split, first person absorbs the remainder; `payer` paid it all. */
const even = (amount: number, people: string[], payer = people[0]): Share[] => {
  const base = Math.floor(amount / people.length);
  return people.map((p, i) => ({
    userId: id(p),
    paidCents: p === payer ? amount : 0,
    owedCents: base + (i === 0 ? amount - base * people.length : 0),
  }));
};

async function createExpense(
  who: string,
  fields: { groupId: number | null; description: string; amountCents: number; people: string[] },
): Promise<any> {
  const res = await call(who, 'POST', '/api/expenses', {
    groupId: fields.groupId,
    description: fields.description,
    amountCents: fields.amountCents,
    currency: 'INR',
    date: '2026-10-01',
    category: 'food',
    notes: null,
    isPayment: false,
    shares: even(fields.amountCents, fields.people),
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function editExpense(who: string, e: any, patch: Record<string, unknown>): Promise<any> {
  const res = await call(who, 'PATCH', `/api/expenses/${e.id}`, {
    groupId: e.groupId,
    description: e.description,
    amountCents: e.amountCents,
    currency: e.currency,
    date: e.date,
    category: e.category,
    notes: e.notes,
    isPayment: e.isPayment,
    shares: e.shares,
    expectedUpdatedAt: e.updatedAt,
    ...patch,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

const history = (who: string, expenseId: number) =>
  call(who, 'GET', `/api/expenses/${expenseId}/revisions`);

const restore = (who: string, expenseId: number, body: Record<string, unknown>) =>
  call(who, 'POST', `/api/expenses/${expenseId}/restore`, body);

const live = (expenseId: number) =>
  (
    seed.prepare('SELECT deleted_at FROM expenses WHERE id = ?').get(expenseId) as {
      deleted_at: string | null;
    }
  ).deleted_at === null;

const removeMember = (groupId: number, who: string) =>
  seed.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, id(who));
const addMember = (groupId: number, who: string) =>
  seed
    .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(groupId, id(who), now());

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-history-'));
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
  for (const n of ['Asha', 'Bilal', 'Chen', 'Dev']) addUser(n);
  befriend('Asha', 'Bilal');
  befriend('Asha', 'Chen');
  goa = addGroup('Goa', ['Asha', 'Bilal', 'Chen']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('expense revisions', () => {
  let dinner: any;

  it('records created / updated revisions, newest first', async () => {
    dinner = await createExpense('Asha', {
      groupId: goa,
      description: 'Dinner',
      amountCents: 40_000,
      people: ['Asha', 'Bilal'],
    });
    dinner = await editExpense('Bilal', dinner, {
      amountCents: 45_000,
      shares: even(45_000, ['Asha', 'Bilal']),
    });
    const res = await history('Asha', dinner.id);
    assert.equal(res.status, 200);
    const revs = res.data.revisions;
    assert.deepEqual(
      revs.map((r: any) => [r.revision, r.action, r.actorId]),
      [
        [2, 'updated', id('Bilal')],
        [1, 'created', id('Asha')],
      ],
    );
    assert.deepEqual(revs[1].snapshot, {
      description: 'Dinner',
      amountCents: 40_000,
      currency: 'INR',
      date: '2026-10-01',
      category: 'food',
      notes: null,
      groupId: goa,
      isPayment: false,
      shares: even(40_000, ['Asha', 'Bilal']),
    });
    assert.equal(revs[0].snapshot.amountCents, 45_000);
    const names = res.data.users.map((u: any) => u.name).sort();
    assert.deepEqual(names, ['Asha', 'Bilal']);
  });

  it('is visible to group members only', async () => {
    assert.equal((await history('Chen', dinner.id)).status, 200);
    assert.equal((await history('Dev', dinner.id)).status, 404);
    assert.equal((await history('Dev', 999_999)).status, 404);
  });

  it('reverts to an older version as a new restored revision', async () => {
    const stale = await restore('Asha', dinner.id, {
      revision: 1,
      expectedUpdatedAt: dinner.createdAt,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'conflict');

    const res = await restore('Asha', dinner.id, {
      revision: 1,
      expectedUpdatedAt: dinner.updatedAt,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.amountCents, 40_000);
    assert.deepEqual(res.data.shares, even(40_000, ['Asha', 'Bilal']));
    dinner = res.data;

    const revs = (await history('Asha', dinner.id)).data.revisions;
    assert.deepEqual(
      revs.map((r: any) => [r.revision, r.action]),
      [
        [3, 'restored'],
        [2, 'updated'],
        [1, 'created'],
      ],
    );
    const { data } = await call('Bilal', 'GET', '/api/sync');
    const entry = data.activity.find((a: any) => a.type === 'expense_restored');
    assert.ok(entry);
    assert.equal(entry.summary, "Asha restored 'Dinner' in Goa");

    const again = await restore('Asha', dinner.id, { revision: 1 });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'already current');
    assert.equal((await restore('Asha', dinner.id, { revision: 42 })).status, 404);
    assert.equal((await restore('Dev', dinner.id, { revision: 2 })).status, 404);
  });

  it('records a delete, lists it as recently deleted, and undeletes it', async () => {
    assert.equal((await call('Bilal', 'DELETE', `/api/expenses/${dinner.id}`)).status, 204);
    const revs = (await history('Asha', dinner.id)).data.revisions;
    assert.deepEqual(
      [revs[0].revision, revs[0].action, revs[0].actorId],
      [4, 'deleted', id('Bilal')],
    );

    const listed = await call('Asha', 'GET', `/api/expenses/deleted?groupId=${goa}`);
    assert.equal(listed.status, 200);
    const row = listed.data.expenses.find((e: any) => e.id === dinner.id);
    assert.ok(row);
    assert.equal(row.deletedBy, id('Bilal'));
    assert.equal(row.revision, 4);
    assert.ok(row.deletedAt);
    assert.equal((await call('Dev', 'GET', `/api/expenses/deleted?groupId=${goa}`)).status, 404);
    const forBilal = await call('Asha', 'GET', `/api/expenses/deleted?friendId=${id('Bilal')}`);
    assert.ok(forBilal.data.expenses.some((e: any) => e.id === dinner.id));
    const forChen = await call('Asha', 'GET', `/api/expenses/deleted?friendId=${id('Chen')}`);
    assert.ok(!forChen.data.expenses.some((e: any) => e.id === dinner.id));

    const res = await restore('Chen', dinner.id, {
      revision: 4,
      expectedUpdatedAt: row.updatedAt,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(live(dinner.id));
    const { data } = await call('Asha', 'GET', '/api/sync');
    assert.ok(data.expenses.some((e: any) => e.id === dinner.id));
    const after = await call('Asha', 'GET', `/api/expenses/deleted?groupId=${goa}`);
    assert.ok(!after.data.expenses.some((e: any) => e.id === dinner.id));
    const latest = (await history('Asha', dinner.id)).data.revisions[0];
    assert.deepEqual([latest.revision, latest.action, latest.actorId], [5, 'restored', id('Chen')]);
  });

  it('restores 1:1 expenses for its two people only', async () => {
    const coffee = await createExpense('Asha', {
      groupId: null,
      description: 'Coffee',
      amountCents: 600,
      people: ['Asha', 'Bilal'],
    });
    assert.equal((await call('Asha', 'DELETE', `/api/expenses/${coffee.id}`)).status, 204);
    assert.equal((await history('Chen', coffee.id)).status, 404);
    const listed = await call('Bilal', 'GET', `/api/expenses/deleted?friendId=${id('Asha')}`);
    assert.ok(listed.data.expenses.some((e: any) => e.id === coffee.id));
    assert.equal((await restore('Chen', coffee.id, { revision: 2 })).status, 404);
    const res = await restore('Bilal', coffee.id, { revision: 2 });
    assert.equal(res.status, 200);
    assert.ok(live(coffee.id));
  });
});

describe('restore guards', () => {
  it('refuses an undelete that would move a departed member', async () => {
    const taxi = await createExpense('Asha', {
      groupId: goa,
      description: 'Taxi',
      amountCents: 3_000,
      people: ['Asha', 'Bilal', 'Chen'],
    });
    assert.equal((await call('Asha', 'DELETE', `/api/expenses/${taxi.id}`)).status, 204);
    removeMember(goa, 'Chen');
    try {
      const res = await restore('Asha', taxi.id, { revision: 2 });
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'departed member');
      assert.ok(!live(taxi.id));
    } finally {
      addMember(goa, 'Chen');
    }
  });

  it('refuses a version naming someone who has left since', async () => {
    let lunch = await createExpense('Asha', {
      groupId: goa,
      description: 'Lunch',
      amountCents: 9_000,
      people: ['Asha', 'Bilal', 'Chen'],
    });
    lunch = await editExpense('Asha', lunch, { shares: even(9_000, ['Asha', 'Bilal']) });
    removeMember(goa, 'Chen');
    try {
      const res = await restore('Asha', lunch.id, { revision: 1 });
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'member left');
    } finally {
      addMember(goa, 'Chen');
    }
  });

  it('404s once the group is deleted', async () => {
    const trip = addGroup('Trip', ['Asha', 'Bilal']);
    const snack = await createExpense('Asha', {
      groupId: trip,
      description: 'Snack',
      amountCents: 200,
      people: ['Asha', 'Bilal'],
    });
    assert.equal((await call('Asha', 'DELETE', `/api/expenses/${snack.id}`)).status, 204);
    seed.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(now(), trip);
    assert.equal((await restore('Asha', snack.id, { revision: 2 })).status, 404);
    assert.equal((await history('Asha', snack.id)).status, 404);
  });

  it('records settle-up rows and their undo, but never restores them', async () => {
    const settle = await call('Asha', 'POST', '/api/settlements', {
      counterpartyId: id('Bilal'),
      currency: 'INR',
      date: '2026-10-07',
      rows: [{ groupId: goa, payerId: id('Bilal'), recipientId: id('Asha'), amountCents: 1_000 }],
    });
    assert.equal(settle.status, 200, JSON.stringify(settle.data));
    const rowId = settle.data.expenses[0].id;
    const created = (await history('Chen', rowId)).data.revisions;
    assert.deepEqual(
      created.map((r: any) => [r.revision, r.action, r.actorId, r.snapshot.isPayment]),
      [[1, 'created', id('Asha'), true]],
    );
    const undo = await call('Bilal', 'DELETE', `/api/settlements/${settle.data.batch.id}`);
    assert.equal(undo.status, 204);
    const revs = (await history('Asha', rowId)).data.revisions;
    assert.deepEqual([revs[0].action, revs[0].actorId], ['deleted', id('Bilal')]);
    const res = await restore('Asha', rowId, { revision: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'part of a settle-up');
    assert.ok(!live(rowId));
    const listed = await call('Asha', 'GET', `/api/expenses/deleted?groupId=${goa}`);
    assert.ok(!listed.data.expenses.some((e: any) => e.id === rowId));
  });
});

describe('revision backfill', () => {
  // Importing db.ts runs the schema migration + backfill, as a server boot does.
  const runMigration = () =>
    execFileSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/db.ts')"], {
      cwd: SERVER_DIR,
      env: { ...process.env, DB_PATH: path.join(dir, 'test.db') },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  const insertLegacy = (description: string, deletedAt: string | null) => {
    const eid = Number(
      seed
        .prepare(
          `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category,
             notes, is_payment, created_by, created_at, updated_at, deleted_at)
           VALUES (?, ?, 500, 'INR', '2025-01-01', 'general', 'old', 0, ?, ?, ?, ?)`,
        )
        .run(goa, description, id('Asha'), '2025-01-01T10:00:00.000Z', now(), deletedAt)
        .lastInsertRowid,
    );
    const share = seed.prepare(
      'INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents) VALUES (?, ?, ?, ?)',
    );
    share.run(eid, id('Asha'), 500, 250);
    share.run(eid, id('Bilal'), 0, 250);
    return eid;
  };
  const revCount = () =>
    (seed.prepare('SELECT COUNT(*) AS n FROM expense_revisions').get() as { n: number }).n;

  it('gives legacy expenses a history, exactly once', async () => {
    const liveId = insertLegacy('Old rent', null);
    const goneId = insertLegacy('Old snacks', '2025-02-01T10:00:00.000Z');
    seed
      .prepare(
        `INSERT INTO activity (actor_id, type, group_id, expense_id, summary, created_at)
         VALUES (?, 'expense_deleted', ?, ?, 'x', ?)`,
      )
      .run(id('Bilal'), goa, goneId, now());
    const before = revCount();
    runMigration();
    assert.equal(revCount(), before + 3);

    const liveRevs = (await history('Asha', liveId)).data.revisions;
    assert.deepEqual(
      liveRevs.map((r: any) => [r.revision, r.action, r.actorId, r.createdAt]),
      [[1, 'created', id('Asha'), '2025-01-01T10:00:00.000Z']],
    );
    assert.equal(liveRevs[0].snapshot.notes, 'old');
    assert.equal(liveRevs[0].snapshot.isPayment, false);
    assert.deepEqual(liveRevs[0].snapshot.shares, [
      { userId: id('Asha'), paidCents: 500, owedCents: 250 },
      { userId: id('Bilal'), paidCents: 0, owedCents: 250 },
    ]);
    const goneRevs = (await history('Asha', goneId)).data.revisions;
    assert.deepEqual(
      goneRevs.map((r: any) => [r.revision, r.action, r.actorId, r.createdAt]),
      [
        [2, 'deleted', id('Bilal'), '2025-02-01T10:00:00.000Z'],
        [1, 'created', id('Asha'), '2025-01-01T10:00:00.000Z'],
      ],
    );

    runMigration();
    assert.equal(revCount(), before + 3, 'a second run adds nothing');
  });
});
