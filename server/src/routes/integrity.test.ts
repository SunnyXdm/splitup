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
 * End-to-end integrity checks: idempotent replays re-check access and
 * liveness, reused keys are refused, superseded payments stay deleted,
 * friendships clear pending requests, guest claims tidy up after themselves,
 * and push endpoints must be public.
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

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-integrity-'));
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
  for (const n of ['Asha', 'Bilal', 'Chen', 'Dan']) addUser(n);
  befriend('Asha', 'Bilal');
  befriend('Asha', 'Chen');
  goa = addGroup('Goa', ['Asha', 'Bilal', 'Chen']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const groupExpense = (clientKey: string, amountCents = 3_000) => ({
  groupId: goa,
  description: 'Dinner',
  amountCents,
  currency: 'INR',
  date: '2026-10-01',
  category: 'food',
  notes: null,
  isPayment: false,
  shares: [
    { userId: id('Asha'), paidCents: amountCents, owedCents: amountCents / 2 },
    { userId: id('Bilal'), paidCents: 0, owedCents: amountCents / 2 },
  ],
  clientKey,
});

const directExpense = (clientKey: string) => ({
  ...groupExpense(clientKey),
  groupId: null,
});

describe('idempotent replay', () => {
  it('replays only while the caller can still see the expense', async () => {
    const first = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0001'));
    assert.equal(first.status, 200);
    const again = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0001'));
    assert.equal(again.status, 200);
    assert.equal(again.data.id, first.data.id);

    // Removed from the group: the replay must not hand the row back.
    seed
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(goa, id('Asha'));
    const hidden = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0001'));
    assert.equal(hidden.status, 404);
    seed
      .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(goa, id('Asha'), now());

    // A deleted group hides it too.
    seed.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(now(), goa);
    const gone = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0001'));
    assert.equal(gone.status, 404);
    seed.prepare('UPDATE groups SET deleted_at = NULL WHERE id = ?').run(goa);
  });

  it('refuses to replay a deleted expense as live', async () => {
    const first = await call('Asha', 'POST', '/api/expenses', directExpense('replay-key-0002'));
    assert.equal(first.status, 200);
    assert.equal((await call('Bilal', 'DELETE', `/api/expenses/${first.data.id}`)).status, 204);
    const res = await call('Asha', 'POST', '/api/expenses', directExpense('replay-key-0002'));
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'already saved and later removed');
  });

  it('refuses a different payload under the same key, naming the expense', async () => {
    const first = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0003'));
    assert.equal(first.status, 200);
    const res = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0003', 5_000));
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'key reused');
    assert.equal(res.data.expenseId, first.data.id);
  });

  it('still replays the original payload after the expense was edited', async () => {
    const first = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0004'));
    const { clientKey: _, ...edit } = groupExpense('replay-key-0004', 4_000);
    const patched = await call('Bilal', 'PATCH', `/api/expenses/${first.data.id}`, edit);
    assert.equal(patched.status, 200);
    const res = await call('Asha', 'POST', '/api/expenses', groupExpense('replay-key-0004'));
    assert.equal(res.status, 200);
    assert.equal(res.data.id, first.data.id);
    assert.equal(res.data.amountCents, 4_000);
  });

  it('refuses to replay an undone settle-up, or a different one under its key', async () => {
    const settle = (amountCents: number) => ({
      counterpartyId: id('Bilal'),
      currency: 'INR',
      date: '2026-10-02',
      clientKey: 'replay-settle-01',
      rows: [{ groupId: goa, payerId: id('Bilal'), recipientId: id('Asha'), amountCents }],
    });
    const first = await call('Asha', 'POST', '/api/settlements', settle(500));
    assert.equal(first.status, 200);
    const reused = await call('Asha', 'POST', '/api/settlements', settle(700));
    assert.equal(reused.status, 409);
    assert.equal(reused.data.error, 'key reused');
    const undo = await call('Bilal', 'DELETE', `/api/settlements/${first.data.batch.id}`);
    assert.equal(undo.status, 204);
    const res = await call('Asha', 'POST', '/api/settlements', settle(500));
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'already saved and later removed');
  });

  it('refuses to replay a deleted recurring bill', async () => {
    const body = {
      groupId: goa,
      friendId: null,
      template: {
        description: 'Wifi',
        amountCents: 2_000,
        currency: 'INR',
        category: 'home',
        notes: null,
        split: {
          mode: 'equal',
          participants: [id('Asha'), id('Bilal')],
          payers: [{ userId: id('Asha'), cents: 2_000 }],
        },
      },
      cadence: 'monthly',
      anchorDate: '2026-10-01',
      clientKey: 'replay-rule-0001',
    };
    const first = await call('Asha', 'POST', '/api/recurring?today=2026-10-01', body);
    assert.equal(first.status, 200);
    const removed = await call('Asha', 'DELETE', `/api/recurring/${first.data.rule.id}`);
    assert.equal(removed.status, 204);
    const res = await call('Asha', 'POST', '/api/recurring?today=2026-10-01', body);
    assert.equal(res.status, 409);
  });
});

describe('superseded payments', () => {
  /** A deleted legacy payment Asha → Chen and its live migration replacement. */
  function seedMigrated(mark: boolean): { original: number; replacement: number } {
    const insert = seed.prepare(
      `INSERT INTO expenses (group_id, description, amount_cents, currency, date, category, notes,
         is_payment, created_by, created_at, updated_at, deleted_at)
       VALUES (?, 'Payment', 800, 'INR', '2026-09-01', 'general', ?, 1, ?, ?, ?, ?)`,
    );
    const share = seed.prepare(
      'INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents) VALUES (?, ?, ?, ?)',
    );
    const t = now();
    const original = Number(insert.run(null, null, id('Asha'), t, t, t).lastInsertRowid);
    share.run(original, id('Asha'), 800, 0);
    share.run(original, id('Chen'), 0, 800);
    const replacement = Number(
      insert.run(goa, `migrated from #${original}`, id('Asha'), t, t, null).lastInsertRowid,
    );
    share.run(replacement, id('Asha'), 800, 0);
    share.run(replacement, id('Chen'), 0, 800);
    const rev = seed.prepare(
      `INSERT INTO expense_revisions (expense_id, revision, action, actor_id, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const snap = JSON.stringify({
      description: 'Payment',
      amountCents: 800,
      currency: 'INR',
      date: '2026-09-01',
      category: 'general',
      notes: null,
      groupId: null,
      isPayment: true,
      shares: [
        { userId: id('Asha'), paidCents: 800, owedCents: 0 },
        { userId: id('Chen'), paidCents: 0, owedCents: 800 },
      ],
    });
    rev.run(original, 1, 'created', id('Asha'), snap, t);
    rev.run(original, 2, 'deleted', id('Asha'), snap, t);
    if (mark) {
      seed.prepare('UPDATE expenses SET superseded_by = ? WHERE id = ?').run(replacement, original);
    }
    return { original, replacement };
  }

  for (const mark of [true, false]) {
    it(`are neither listed nor restorable (${mark ? 'marked' : 'found by notes'})`, async () => {
      const { original } = seedMigrated(mark);
      const list = await call('Chen', 'GET', `/api/expenses/deleted?friendId=${id('Asha')}`);
      assert.equal(list.status, 200);
      assert.ok(!list.data.expenses.some((e: { id: number }) => e.id === original));
      const res = await call('Chen', 'POST', `/api/expenses/${original}/restore`, { revision: 1 });
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'superseded');
    });
  }
});

describe('friend requests', () => {
  it('a group join clears pending requests between the new friends', async () => {
    const sent = await call('Dan', 'POST', '/api/friends', { email: 'asha@example.com' });
    assert.equal(sent.data.status, 'requested');
    const sentBack = await call('Chen', 'POST', '/api/friends', { email: 'dan@example.com' });
    assert.equal(sentBack.data.status, 'requested');
    const invite = await call('Asha', 'POST', `/api/groups/${goa}/invites`);
    assert.equal((await call('Dan', 'POST', `/api/invites/${invite.data.token}/join`)).status, 200);
    const left = seed
      .prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ? OR to_email = ?')
      .get(id('Dan'), 'dan@example.com') as { n: number };
    assert.equal(left.n, 0);
    const { data } = await call('Asha', 'GET', '/api/sync');
    assert.equal(data.friendRequests.incoming.length, 0);
  });

  it('counts only unresolved requests against the outgoing quota', async () => {
    // 50 requests to people Bilal is (by now) friends with: all resolved.
    const insertUser = seed.prepare(
      "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES (?, ?, ?, 'INR', ?)",
    );
    const friendship = seed.prepare(
      'INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    );
    const request = seed.prepare(
      'INSERT INTO friend_requests (from_id, to_email, created_at) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 50; i++) {
      const email = `quota${i}@example.com`;
      const uid = Number(insertUser.run(`sub-quota-${i}`, email, `Q${i}`, now()).lastInsertRowid);
      friendship.run(id('Bilal'), uid, now());
      friendship.run(uid, id('Bilal'), now());
      request.run(id('Bilal'), email, now());
    }
    const res = await call('Bilal', 'POST', '/api/friends', { email: 'newperson@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'requested');
  });
});

describe('guest claims', () => {
  it('records revisions, drops payments to oneself, and keeps balances', async () => {
    const group = (
      await call('Asha', 'POST', '/api/groups', { name: 'Trip', currency: 'INR' })
    ).data.id;
    const invite = await call('Asha', 'POST', `/api/groups/${group}/invites`);
    await call('Bilal', 'POST', `/api/invites/${invite.data.token}/join`);
    const guest = (await call('Asha', 'POST', `/api/groups/${group}/guests`, { name: 'Ravi' }))
      .data.user.id;
    // Ravi owes Bilal 1000 and Asha 1000; then Ravi pays Bilal back 600.
    const dinner = await call('Asha', 'POST', '/api/expenses', {
      groupId: group,
      description: 'Dinner',
      amountCents: 3_000,
      currency: 'INR',
      date: '2026-10-01',
      category: 'food',
      notes: null,
      isPayment: false,
      shares: [
        { userId: id('Asha'), paidCents: 2_000, owedCents: 1_000 },
        { userId: id('Bilal'), paidCents: 1_000, owedCents: 0 },
        { userId: guest, paidCents: 0, owedCents: 2_000 },
      ],
    });
    assert.equal(dinner.status, 200);
    const settled = await call('Bilal', 'POST', '/api/settlements', {
      counterpartyId: guest,
      currency: 'INR',
      date: '2026-10-02',
      rows: [{ groupId: group, payerId: guest, recipientId: id('Bilal'), amountCents: 600 }],
    });
    assert.equal(settled.status, 200);
    // Bilal (the claimer) archived the group earlier.
    assert.equal((await call('Bilal', 'PUT', `/api/groups/${group}/archive`)).status, 200);
    const link = (await call('Asha', 'POST', `/api/groups/${group}/guests/${guest}/claim-link`))
      .data.token;
    const res = await call('Bilal', 'POST', `/api/guest-claims/${link}/accept`);
    assert.equal(res.status, 200);

    const revs = await call('Bilal', 'GET', `/api/expenses/${dinner.data.id}/revisions`);
    assert.equal(revs.data.revisions[0].action, 'updated');
    assert.equal(revs.data.revisions[0].actorId, id('Bilal'));

    const payment = settled.data.expenses[0].id;
    const row = seed
      .prepare('SELECT deleted_at FROM expenses WHERE id = ?')
      .get(payment) as { deleted_at: string | null };
    assert.ok(row.deleted_at, 'payment to oneself is removed');
    const batch = seed
      .prepare('SELECT deleted_at FROM settlement_batches WHERE id = ?')
      .get(settled.data.batch.id) as { deleted_at: string | null };
    assert.ok(batch.deleted_at, 'its settle-up is removed');
    const paymentRevs = await call('Bilal', 'GET', `/api/expenses/${payment}/revisions`);
    assert.equal(paymentRevs.data.revisions[0].action, 'deleted');

    const { data } = await call('Bilal', 'GET', '/api/sync');
    const g = data.groups.find((x: { id: number }) => x.id === group);
    assert.equal(g.archivedAt, null, 'unarchived for the claimer');
    assert.ok(!data.settlementBatches.some((b: { id: number }) => b.id === settled.data.batch.id));
    // Bilal: +1000 (paid) − 2000 (Ravi's share) = −1000 net, payment gone.
    const nets = new Map<number, number>();
    for (const e of data.expenses.filter((x: { groupId: number }) => x.groupId === group)) {
      for (const s of e.shares) {
        nets.set(s.userId, (nets.get(s.userId) ?? 0) + s.paidCents - s.owedCents);
      }
    }
    assert.equal(nets.get(id('Bilal')), -1_000);
    assert.equal(nets.get(id('Asha')), 1_000);
  });
});

describe('push subscriptions', () => {
  it('refuses endpoints off port 443', async () => {
    const res = await call('Asha', 'POST', '/api/push/subscriptions', {
      endpoint: 'https://push.example.com:8443/send/abc',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    });
    assert.equal(res.status, 400);
  });
});
