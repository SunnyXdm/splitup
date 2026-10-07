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
 * End-to-end: guest participants and claiming. Boots the real server against
 * a throwaway database, seeds users and sessions directly, and drives the
 * guest / expense / settlement / claim endpoints over HTTP.
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

async function callWith(
  token: string | undefined,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(token ? { cookie: `splitup_session=${token}` } : {}),
      'x-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const call = (who: string, method: string, url: string, body?: unknown) =>
  callWith(tokens.get(who), method, url, body);

const now = () => new Date().toISOString();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function seedSession(userId: number): string {
  const token = randomBytes(32).toString('hex');
  seed
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), userId, now(), new Date(Date.now() + 86_400_000).toISOString());
  return token;
}

function addUser(name: string): void {
  const id = Number(
    seed
      .prepare(
        "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES (?, ?, ?, 'INR', ?)",
      )
      .run(`sub-${name}`, `${name.toLowerCase().replace(/\s/g, '')}@example.com`, name, now())
      .lastInsertRowid,
  );
  ids.set(name, id);
  tokens.set(name, seedSession(id));
}

function befriend(a: string, b: string): void {
  const stmt = seed.prepare(
    'INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
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

/** Live per-user nets of a group (single currency here), zeros dropped. */
function nets(groupId: number): Map<number, number> {
  const rows = seed
    .prepare(
      `SELECT s.user_id AS uid, SUM(s.paid_cents - s.owed_cents) AS net
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? AND e.deleted_at IS NULL GROUP BY s.user_id`,
    )
    .all(groupId) as { uid: number; net: number }[];
  return new Map(rows.filter((r) => r.net !== 0).map((r) => [r.uid, r.net]));
}

const isMember = (groupId: number, userId: number) =>
  seed
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId) !== undefined;

const areFriends = (a: number, b: number) =>
  seed.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(a, b) !==
  undefined;

function split(
  groupId: number | null,
  amountCents: number,
  shares: [number, number, number][],
  extra: Record<string, unknown> = {},
) {
  return {
    groupId,
    description: 'Dinner',
    amountCents,
    currency: 'INR',
    date: '2026-10-07',
    category: 'food',
    notes: null,
    isPayment: false,
    shares: shares.map(([userId, paidCents, owedCents]) => ({ userId, paidCents, owedCents })),
    ...extra,
  };
}

let goa: number;
let ravi: number;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-guests-'));
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
  for (const n of ['Asha', 'Bilal', 'Chen', 'Ravi Kumar', 'Dev']) addUser(n);
  befriend('Asha', 'Bilal');
  befriend('Asha', 'Chen');
  befriend('Asha', 'Dev');
  befriend('Bilal', 'Dev');
  goa = addGroup('Goa', ['Asha', 'Bilal', 'Dev']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('managing guests', () => {
  it('adds a guest as a group member with activity', async () => {
    const res = await call('Asha', 'POST', `/api/groups/${goa}/guests`, { name: '  Ravi  ' });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.name, 'Ravi');
    assert.equal(res.data.user.isGuest, true);
    assert.equal(res.data.user.email, null);
    ravi = res.data.user.id;
    assert.ok(res.data.group.memberIds.includes(ravi));
    const row = seed.prepare('SELECT * FROM users WHERE id = ?').get(ravi) as {
      shoo_sub: string;
      is_guest: number;
      guest_of_group: number;
      created_by: number;
    };
    assert.match(row.shoo_sub, /^guest:[0-9a-f]{32}$/);
    assert.equal(row.is_guest, 1);
    assert.equal(row.guest_of_group, goa);
    assert.equal(row.created_by, id('Asha'));
    const { data } = await call('Bilal', 'GET', '/api/sync');
    const summaries = data.activity.map((a: { summary: string }) => a.summary);
    assert.ok(summaries.includes('Asha added guest Ravi'));
  });

  it('validates the name', async () => {
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const res = await call('Asha', 'POST', `/api/groups/${goa}/guests`, { name });
      assert.equal(res.status, 400, JSON.stringify(name));
    }
  });

  it('404s non-members on every guest endpoint', async () => {
    const add = await call('Chen', 'POST', `/api/groups/${goa}/guests`, { name: 'X' });
    assert.equal(add.status, 404);
    assert.equal(
      (await call('Chen', 'PATCH', `/api/groups/${goa}/guests/${ravi}`, { name: 'X' })).status,
      404,
    );
    assert.equal((await call('Chen', 'DELETE', `/api/groups/${goa}/guests/${ravi}`)).status, 404);
    assert.equal(
      (await call('Chen', 'POST', `/api/groups/${goa}/guests/${ravi}/claim-link`)).status,
      404,
    );
    // A real member's id is not a guest.
    assert.equal(
      (await call('Asha', 'PATCH', `/api/groups/${goa}/guests/${id('Bilal')}`, { name: 'X' }))
        .status,
      404,
    );
  });

  it('renames a guest', async () => {
    const res = await call('Bilal', 'PATCH', `/api/groups/${goa}/guests/${ravi}`, {
      name: 'Ravi G',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.name, 'Ravi G');
    await call('Bilal', 'PATCH', `/api/groups/${goa}/guests/${ravi}`, { name: 'Ravi' });
  });

  it('syncs guests as members with isGuest, never as friends', async () => {
    for (const who of ['Asha', 'Bilal']) {
      const { data } = await call(who, 'GET', '/api/sync');
      const u = data.users.find((x: { id: number }) => x.id === ravi);
      assert.equal(u.isGuest, true);
      assert.equal(data.friendIds.includes(ravi), false);
      const g = data.groups.find((x: { id: number }) => x.id === goa);
      assert.ok(g.memberIds.includes(ravi));
      const me = data.users.find((x: { id: number }) => x.id === id(who));
      assert.equal(me.isGuest, undefined);
    }
    assert.equal(areFriends(id('Asha'), ravi), false);
  });

  it('removes a settled guest but keeps the user row', async () => {
    const temp = (await call('Asha', 'POST', `/api/groups/${goa}/guests`, { name: 'Temp' })).data
      .user.id;
    const res = await call('Bilal', 'DELETE', `/api/groups/${goa}/guests/${temp}`);
    assert.equal(res.status, 204);
    assert.equal(isMember(goa, temp), false);
    assert.ok(seed.prepare('SELECT 1 FROM users WHERE id = ?').get(temp));
    assert.equal((await call('Bilal', 'DELETE', `/api/groups/${goa}/guests/${temp}`)).status, 404);
  });
});

describe('guests in the ledger', () => {
  it('allows a guest in a group expense', async () => {
    const res = await call(
      'Asha',
      'POST',
      '/api/expenses',
      split(goa, 900, [
        [id('Asha'), 900, 300],
        [id('Bilal'), 0, 300],
        [ravi, 0, 300],
      ]),
    );
    assert.equal(res.status, 200);
  });

  it('rejects a direct (non-group) expense with a guest', async () => {
    const res = await call(
      'Asha',
      'POST',
      '/api/expenses',
      split(null, 500, [
        [id('Asha'), 500, 250],
        [ravi, 0, 250],
      ]),
    );
    assert.equal(res.status, 400);
  });

  it('rejects a guest in another group', async () => {
    const flat = addGroup('Flat', ['Asha', 'Bilal']);
    const res = await call(
      'Asha',
      'POST',
      '/api/expenses',
      split(flat, 500, [
        [id('Asha'), 500, 250],
        [ravi, 0, 250],
      ]),
    );
    assert.equal(res.status, 400);
  });

  it('allows a group payment from a guest', async () => {
    const res = await call(
      'Bilal',
      'POST',
      '/api/expenses',
      split(
        goa,
        100,
        [
          [ravi, 100, 0],
          [id('Bilal'), 0, 100],
        ],
        { isPayment: true },
      ),
    );
    assert.equal(res.status, 200);
  });

  it('settles with a guest inside the group, never directly', async () => {
    const ok = await call('Asha', 'POST', '/api/settlements', {
      counterpartyId: ravi,
      currency: 'INR',
      date: '2026-10-07',
      rows: [{ groupId: goa, payerId: ravi, recipientId: id('Asha'), amountCents: 100 }],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.batch.payerId, ravi);
    const direct = await call('Asha', 'POST', '/api/settlements', {
      counterpartyId: ravi,
      currency: 'INR',
      date: '2026-10-07',
      rows: [{ groupId: null, payerId: ravi, recipientId: id('Asha'), amountCents: 100 }],
    });
    assert.equal(direct.status, 400);
    // Chen isn't in Goa: no relaxation for him.
    const outsider = await call('Chen', 'POST', '/api/settlements', {
      counterpartyId: ravi,
      currency: 'INR',
      date: '2026-10-07',
      rows: [{ groupId: goa, payerId: ravi, recipientId: id('Chen'), amountCents: 100 }],
    });
    assert.notEqual(outsider.status, 200);
  });

  it('refuses to remove an unsettled guest', async () => {
    assert.equal(nets(goa).get(ravi), -100);
    const res = await call('Asha', 'DELETE', `/api/groups/${goa}/guests/${ravi}`);
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'unsettled');
    const viaMembers = await call('Asha', 'DELETE', `/api/groups/${goa}/members/${ravi}`);
    assert.equal(viaMembers.status, 409);
    assert.ok(isMember(goa, ravi));
  });

  it('lets a guest be in a recurring group bill but not a 1:1 one', async () => {
    const template = {
      description: 'Rent',
      amountCents: 600,
      currency: 'INR',
      category: 'home',
      notes: null,
      split: {
        mode: 'equal',
        participants: [id('Asha'), ravi],
        payers: [{ userId: id('Asha'), cents: 600 }],
      },
    };
    const group = await call('Asha', 'POST', '/api/recurring', {
      groupId: goa,
      friendId: null,
      template,
      cadence: 'monthly',
      anchorDate: '2030-01-01',
    });
    assert.equal(group.status, 200);
    const direct = await call('Asha', 'POST', '/api/recurring', {
      groupId: null,
      friendId: ravi,
      template,
      cadence: 'monthly',
      anchorDate: '2030-01-01',
    });
    assert.equal(direct.status, 400);
  });

  it('never lets a guest hold a session', async () => {
    const token = seedSession(ravi);
    const res = await callWith(token, 'GET', '/api/sync');
    assert.equal(res.status, 401);
    assert.equal(seed.prepare('SELECT 1 FROM sessions WHERE id = ?').get(hash(token)), undefined);
  });
});

describe('claiming a guest', () => {
  let token: string;
  let firstExpenseId: number;

  it('creates a claim link', async () => {
    const res = await call('Asha', 'POST', `/api/groups/${goa}/guests/${ravi}/claim-link`);
    assert.equal(res.status, 200);
    token = res.data.token;
    assert.match(token, /^[0-9a-f]{16}$/);
    assert.match(res.data.url, new RegExp(`/claim/${token}$`));
  });

  it('previews the claim for anyone signed in', async () => {
    const res = await call('Ravi Kumar', 'GET', `/api/guest-claims/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.guest.name, 'Ravi');
    assert.equal(res.data.groupId, goa);
    assert.equal(res.data.groupName, 'Goa');
    assert.equal(res.data.inviter.name, 'Asha');
    assert.equal(res.data.alreadyMember, false);
    assert.equal((await callWith(undefined, 'GET', `/api/guest-claims/${token}`)).status, 401);
    assert.equal((await call('Ravi Kumar', 'GET', '/api/guest-claims/nothex')).status, 404);
  });

  it('refuses the link creator', async () => {
    const res = await call('Asha', 'POST', `/api/guest-claims/${token}/accept`);
    assert.equal(res.status, 400);
  });

  it('merges the guest into the caller with balances conserved', async () => {
    firstExpenseId = (
      seed
        .prepare(
          `SELECT e.id FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
           WHERE s.user_id = ? AND e.is_payment = 0 ORDER BY e.id LIMIT 1`,
        )
        .get(ravi) as { id: number }
    ).id;
    const before = nets(goa);
    const res = await call('Ravi Kumar', 'POST', `/api/guest-claims/${token}/accept`);
    assert.equal(res.status, 200);
    assert.equal(res.data.group.id, goa);
    const after = nets(goa);
    const expected = new Map(before);
    expected.set(id('Ravi Kumar'), expected.get(ravi)!);
    expected.delete(ravi);
    assert.deepEqual(after, expected);

    assert.equal(isMember(goa, ravi), false);
    assert.ok(isMember(goa, id('Ravi Kumar')));
    for (const other of ['Asha', 'Bilal', 'Dev']) {
      assert.ok(areFriends(id('Ravi Kumar'), id(other)), other);
      assert.ok(areFriends(id(other), id('Ravi Kumar')), other);
    }
    const row = seed.prepare('SELECT merged_into FROM users WHERE id = ?').get(ravi) as {
      merged_into: number;
    };
    assert.equal(row.merged_into, id('Ravi Kumar'));
    const left = seed
      .prepare('SELECT COUNT(*) AS n FROM expense_shares WHERE user_id = ?')
      .get(ravi) as { n: number };
    assert.equal(left.n, 0);
    const batch = seed
      .prepare('SELECT COUNT(*) AS n FROM settlement_batches WHERE payer_id = ? OR payee_id = ?')
      .get(ravi, ravi) as { n: number };
    assert.equal(batch.n, 0);
    const rule = seed
      .prepare('SELECT template FROM recurring_rules WHERE group_id = ?')
      .get(goa) as { template: string };
    assert.deepEqual(JSON.parse(rule.template).split.participants, [id('Asha'), id('Ravi Kumar')]);

    const { data } = await call('Ravi Kumar', 'GET', '/api/sync');
    assert.ok(data.groups.some((g: { id: number }) => g.id === goa));
    assert.ok(
      data.activity.some(
        (a: { summary: string }) => a.summary === "Ravi's expenses now belong to Ravi Kumar",
      ),
    );
  });

  it('cannot reuse the token', async () => {
    assert.equal((await call('Chen', 'GET', `/api/guest-claims/${token}`)).status, 404);
    assert.equal((await call('Chen', 'POST', `/api/guest-claims/${token}/accept`)).status, 404);
  });

  it('keeps history readable and restores old versions as the claimer', async () => {
    const hist = await call('Bilal', 'GET', `/api/expenses/${firstExpenseId}/revisions`);
    assert.equal(hist.status, 200);
    const oldest = hist.data.revisions.at(-1);
    assert.ok(oldest.snapshot.shares.some((s: { userId: number }) => s.userId === ravi));
    assert.equal(hist.data.users.find((u: { id: number }) => u.id === ravi).isGuest, true);
    const expense = (await call('Asha', 'GET', '/api/sync')).data.expenses.find(
      (e: { id: number }) => e.id === firstExpenseId,
    );
    const edit = await call('Asha', 'PATCH', `/api/expenses/${firstExpenseId}`, {
      ...split(goa, 900, [
        [id('Asha'), 900, 450],
        [id('Bilal'), 0, 450],
        [id('Ravi Kumar'), 0, 0],
      ]),
      expectedUpdatedAt: expense.updatedAt,
    });
    assert.equal(edit.status, 200);
    const restored = await call('Asha', 'POST', `/api/expenses/${firstExpenseId}/restore`, {
      revision: oldest.revision,
    });
    assert.equal(restored.status, 200);
    const owed = new Map(
      restored.data.shares.map((s: { userId: number; owedCents: number }) => [
        s.userId,
        s.owedCents,
      ]),
    );
    assert.equal(owed.get(id('Ravi Kumar')), 300);
    assert.equal(owed.has(ravi), false);
  });

  it('expires claim links after their TTL', async () => {
    const guest = (await call('Asha', 'POST', `/api/groups/${goa}/guests`, { name: 'Old' })).data
      .user.id;
    const link = (await call('Asha', 'POST', `/api/groups/${goa}/guests/${guest}/claim-link`))
      .data.token;
    seed
      .prepare('UPDATE guest_claims SET expires_at = ? WHERE token = ?')
      .run('2000-01-01T00:00:00.000Z', link);
    assert.equal((await call('Chen', 'GET', `/api/guest-claims/${link}`)).status, 404);
    assert.equal((await call('Chen', 'POST', `/api/guest-claims/${link}/accept`)).status, 404);
    assert.ok(isMember(goa, guest));
  });

  it('combines shares when the claimer is already a member', async () => {
    const dee = (await call('Asha', 'POST', `/api/groups/${goa}/guests`, { name: 'Dee' })).data
      .user.id;
    const both = await call(
      'Dev',
      'POST',
      '/api/expenses',
      split(goa, 600, [
        [id('Dev'), 600, 200],
        [dee, 0, 200],
        [id('Asha'), 0, 200],
      ]),
    );
    assert.equal(both.status, 200);
    const deeOnly = await call(
      'Asha',
      'POST',
      '/api/expenses',
      split(goa, 300, [
        [dee, 300, 100],
        [id('Asha'), 0, 200],
      ]),
    );
    assert.equal(deeOnly.status, 200);
    const link = (await call('Asha', 'POST', `/api/groups/${goa}/guests/${dee}/claim-link`)).data
      .token;
    const preview = await call('Dev', 'GET', `/api/guest-claims/${link}`);
    assert.equal(preview.data.alreadyMember, true);

    const before = nets(goa);
    const res = await call('Dev', 'POST', `/api/guest-claims/${link}/accept`);
    assert.equal(res.status, 200);
    const after = nets(goa);
    const expected = new Map(before);
    const sum = (expected.get(id('Dev')) ?? 0) + (expected.get(dee) ?? 0);
    expected.delete(dee);
    if (sum === 0) expected.delete(id('Dev'));
    else expected.set(id('Dev'), sum);
    assert.deepEqual(after, expected);

    const shares = seed
      .prepare('SELECT * FROM expense_shares WHERE expense_id = ? ORDER BY user_id')
      .all(both.data.id) as { user_id: number; paid_cents: number; owed_cents: number }[];
    const devShare = shares.find((s) => s.user_id === id('Dev'))!;
    assert.equal(devShare.paid_cents, 600);
    assert.equal(devShare.owed_cents, 400);
    assert.equal(
      shares.some((s) => s.user_id === dee),
      false,
    );
    assert.equal(isMember(goa, dee), false);
  });
});
