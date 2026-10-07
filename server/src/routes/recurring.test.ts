import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { addMonths } from '../lib/recurrence';

/**
 * End-to-end: boots the real server against a throwaway database, seeds users
 * and sessions directly, and drives /api/recurring over HTTP.
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

/** The test's local calendar date — sent as ?today= so the server agrees with us. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const TODAY = localToday();

async function call(
  who: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${base}${url}${sep}today=${TODAY}`, {
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

function unfriend(a: string, b: string): void {
  seed
    .prepare(
      'DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
    )
    .run(ids.get(a), ids.get(b), ids.get(b), ids.get(a));
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
const expenseCount = () =>
  (seed.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n;

interface Pending {
  id: number;
  ruleId: number;
  dueDate: string;
  amountCents: number;
}
const pendingOf = async (who: string, ruleId: number): Promise<Pending[]> => {
  const { data } = await call(who, 'GET', '/api/sync');
  return data.recurring.pending.filter((p: Pending) => p.ruleId === ruleId);
};

const rentTemplate = (participants: string[], amountCents = 3_000_000) => ({
  description: 'Rent',
  amountCents,
  currency: 'INR',
  category: 'home',
  notes: null,
  split: {
    mode: 'equal',
    participants: participants.map(id),
    payers: [{ userId: id('Asha'), cents: amountCents }],
  },
});

let flat: number;
let goa: number;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-recurring-'));
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
  flat = addGroup('Flat', ['Asha', 'Bilal']);
  goa = addGroup('Goa', ['Asha', 'Bilal', 'Chen']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('recurring rules: catch-up, inbox and idempotent add', () => {
  let ruleId: number;
  let pending: Pending[];
  const anchor = addMonths(TODAY, -3);

  it('creates a rule and catches up every missed occurrence as an inbox item', async () => {
    const res = await call('Asha', 'POST', '/api/recurring', {
      groupId: flat,
      friendId: null,
      template: rentTemplate(['Asha', 'Bilal']),
      cadence: 'monthly',
      anchorDate: anchor,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.expense, null);
    ruleId = res.data.rule.id;
    assert.equal(res.data.rule.nextDue, addMonths(anchor, 4));
    pending = await pendingOf('Asha', ruleId);
    assert.deepEqual(
      pending.map((p) => p.dueDate),
      [0, 1, 2, 3].map((n) => addMonths(anchor, n)),
    );
    assert.equal(expenseCount(), 0, 'nothing is auto-posted');
  });

  it('shows the rule read-only to co-members, inbox-free; hides it from others', async () => {
    const bilal = (await call('Bilal', 'GET', '/api/sync')).data.recurring;
    assert.ok(bilal.rules.some((r: { id: number }) => r.id === ruleId));
    assert.equal(bilal.pending.length, 0);
    const dev = (await call('Dev', 'GET', '/api/sync')).data.recurring;
    assert.equal(dev.rules.length, 0);
  });

  it('lets only the creator change it', async () => {
    const bilal = await call('Bilal', 'PATCH', `/api/recurring/${ruleId}`, { paused: true });
    assert.equal(bilal.status, 403);
    const dev = await call('Dev', 'PATCH', `/api/recurring/${ruleId}`, { paused: true });
    assert.equal(dev.status, 404);
    assert.equal((await call('Dev', 'DELETE', `/api/recurring/${ruleId}`)).status, 404);
    const occ = await call('Bilal', 'POST', `/api/recurring/occurrences/${pending[0].id}/add`, {});
    assert.equal(occ.status, 404);
  });

  it('adds an occurrence once, however often it is submitted', async () => {
    const first = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[0].id}/add`, {});
    assert.equal(first.status, 200);
    const e = first.data.expense;
    assert.equal(e.description, 'Rent');
    assert.equal(e.date, pending[0].dueDate);
    assert.deepEqual(
      e.shares.map((s: { owedCents: number }) => s.owedCents),
      [1_500_000, 1_500_000],
    );
    const again = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[0].id}/add`, {
      amountCents: 999,
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.expense.id, e.id);
    assert.equal(expenseCount(), 1);
    const key = seed.prepare('SELECT client_key FROM expenses WHERE id = ?').get(e.id) as {
      client_key: string;
    };
    assert.equal(key.client_key, `rec-${ruleId}-${pending[0].dueDate}`);
    const left = await pendingOf('Asha', ruleId);
    assert.equal(left.length, 3);
  });

  it('re-splits an equal bill for a different amount and date', async () => {
    const res = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[1].id}/add`, {
      amountCents: 3_100_001,
      date: TODAY,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.expense.date, TODAY);
    assert.deepEqual(
      res.data.expense.shares.map((s: { owedCents: number }) => s.owedCents),
      [1_550_001, 1_550_000],
    );
  });

  it('skips idempotently, and a skipped item cannot be added', async () => {
    const skip = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[2].id}/skip`);
    assert.equal(skip.status, 204);
    const again = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[2].id}/skip`);
    assert.equal(again.status, 204);
    const add = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[2].id}/add`, {});
    assert.equal(add.status, 409);
    const added = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[0].id}/skip`);
    assert.equal(added.status, 409, 'an added item cannot be skipped');
    assert.deepEqual(
      (await pendingOf('Asha', ruleId)).map((p) => p.id),
      [pending[3].id],
    );
  });

  it('pauses and resumes without backfilling, and deleting hides it everywhere', async () => {
    const paused = await call('Asha', 'PATCH', `/api/recurring/${ruleId}`, { paused: true });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.paused, true);
    const resumed = await call('Asha', 'PATCH', `/api/recurring/${ruleId}`, { paused: false });
    assert.equal(resumed.data.paused, false);
    assert.ok(resumed.data.nextDue > TODAY);
    assert.equal((await call('Asha', 'DELETE', `/api/recurring/${ruleId}`)).status, 204);
    const sync = (await call('Asha', 'GET', '/api/sync')).data.recurring;
    assert.equal(sync.rules.some((r: { id: number }) => r.id === ruleId), false);
    assert.equal(sync.pending.some((p: Pending) => p.ruleId === ruleId), false);
    const add = await call('Asha', 'POST', `/api/recurring/occurrences/${pending[3].id}/add`, {});
    assert.equal(add.status, 404);
  });
});

describe('recurring rules: create with the first expense ("Repeat")', () => {
  it('records the first expense now, starts next period, and replays by clientKey', async () => {
    const body = {
      groupId: flat,
      friendId: null,
      template: rentTemplate(['Asha', 'Bilal'], 50_000),
      cadence: 'weekly',
      anchorDate: TODAY,
      addFirst: true,
      clientKey: 'repeat-key-0001',
    };
    const before = expenseCount();
    const res = await call('Asha', 'POST', '/api/recurring', body);
    assert.equal(res.status, 200);
    assert.equal(res.data.expense.date, TODAY);
    assert.equal(res.data.rule.nextDue > TODAY, true);
    assert.equal((await pendingOf('Asha', res.data.rule.id)).length, 0);
    const replay = await call('Asha', 'POST', '/api/recurring', body);
    assert.equal(replay.data.rule.id, res.data.rule.id);
    assert.equal(replay.data.expense.id, res.data.expense.id);
    assert.equal(expenseCount(), before + 1);
  });

  it('rejects scopes and splits POST /api/expenses would reject', async () => {
    const base = { cadence: 'monthly', anchorDate: TODAY };
    const notMember = await call('Dev', 'POST', '/api/recurring', {
      ...base,
      groupId: flat,
      friendId: null,
      template: rentTemplate(['Asha', 'Bilal']),
    });
    assert.equal(notMember.status, 404);
    const both = await call('Asha', 'POST', '/api/recurring', {
      ...base,
      groupId: flat,
      friendId: id('Bilal'),
      template: rentTemplate(['Asha', 'Bilal']),
    });
    assert.equal(both.status, 400);
    const outsider = await call('Asha', 'POST', '/api/recurring', {
      ...base,
      groupId: flat,
      friendId: null,
      template: rentTemplate(['Asha', 'Chen']),
    });
    assert.equal(outsider.status, 400);
    const badPercent = await call('Asha', 'POST', '/api/recurring', {
      ...base,
      groupId: flat,
      friendId: null,
      template: {
        ...rentTemplate(['Asha', 'Bilal']),
        split: {
          mode: 'percent',
          participants: [id('Asha'), id('Bilal')],
          values: [
            { userId: id('Asha'), value: 6000 },
            { userId: id('Bilal'), value: 3000 },
          ],
          payers: [{ userId: id('Asha'), cents: 3_000_000 }],
        },
      },
    });
    assert.equal(badPercent.status, 400);
    const notFriend = await call('Asha', 'POST', '/api/recurring', {
      ...base,
      groupId: null,
      friendId: id('Dev'),
      template: rentTemplate(['Asha', 'Dev']),
    });
    assert.equal(notFriend.status, 400);
  });
});

describe('recurring rules: participants are revalidated at add time', () => {
  it('409s when a split member left the group; an edited split still adds', async () => {
    const res = await call('Asha', 'POST', '/api/recurring', {
      groupId: goa,
      friendId: null,
      template: rentTemplate(['Asha', 'Bilal', 'Chen'], 90_000),
      cadence: 'monthly',
      anchorDate: TODAY,
    });
    assert.equal(res.status, 200);
    const [item] = await pendingOf('Asha', res.data.rule.id);
    assert.ok(item);
    seed
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(goa, id('Chen'));
    const stale = await call('Asha', 'POST', `/api/recurring/occurrences/${item.id}/add`, {});
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /Chen is no longer in this group/);
    const reviewed = {
      expense: {
        groupId: goa,
        description: 'Rent',
        amountCents: 90_000,
        currency: 'INR',
        date: TODAY,
        category: 'home',
        notes: null,
        shares: [
          { userId: id('Asha'), paidCents: 90_000, owedCents: 45_000 },
          { userId: id('Bilal'), paidCents: 0, owedCents: 45_000 },
        ],
      },
    };
    const url = `/api/recurring/occurrences/${item.id}/add`;
    const edited = await call('Asha', 'POST', url, reviewed);
    assert.equal(edited.status, 200);
    assert.equal(edited.data.expense.shares.length, 2);
    const replay = await call('Asha', 'POST', url, reviewed);
    assert.equal(replay.status, 200, 'replay after success returns the recorded expense');
    assert.equal(replay.data.expense.id, edited.data.expense.id);
  });

  it('409s a 1:1 bill once the two are no longer friends', async () => {
    const res = await call('Asha', 'POST', '/api/recurring', {
      groupId: null,
      friendId: id('Chen'),
      template: { ...rentTemplate(['Asha', 'Chen'], 1_000), description: 'Netflix' },
      cadence: 'monthly',
      anchorDate: TODAY,
    });
    assert.equal(res.status, 200);
    const [item] = await pendingOf('Asha', res.data.rule.id);
    unfriend('Asha', 'Chen');
    const add = await call('Asha', 'POST', `/api/recurring/occurrences/${item.id}/add`, {});
    assert.equal(add.status, 409);
    assert.match(add.data.error, /Chen is no longer your friend/);
    befriend('Asha', 'Chen');
    const ok = await call('Asha', 'POST', `/api/recurring/occurrences/${item.id}/add`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.data.expense.groupId, null);
    assert.equal(ok.data.expense.shares.length, 2);
  });

  it('refuses a reviewed expense that moves the bill elsewhere', async () => {
    const res = await call('Asha', 'POST', '/api/recurring', {
      groupId: flat,
      friendId: null,
      template: { ...rentTemplate(['Asha', 'Bilal'], 2_000), description: 'Wifi' },
      cadence: 'monthly',
      anchorDate: TODAY,
    });
    const [item] = await pendingOf('Asha', res.data.rule.id);
    const add = await call('Asha', 'POST', `/api/recurring/occurrences/${item.id}/add`, {
      expense: {
        groupId: goa,
        description: 'Wifi',
        amountCents: 2_000,
        currency: 'INR',
        date: TODAY,
        category: 'utilities',
        notes: null,
        shares: [
          { userId: id('Asha'), paidCents: 2_000, owedCents: 1_000 },
          { userId: id('Bilal'), paidCents: 0, owedCents: 1_000 },
        ],
      },
    });
    assert.equal(add.status, 400);
  });
});
