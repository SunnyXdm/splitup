import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Unit checks for the guest helpers. The modules open the database on import,
 * so point DB_PATH at a throwaway file first and import dynamically.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'splitup-guest-unit-'));
process.env.DB_PATH = path.join(dir, 'unit.db');

let auth: typeof import('../auth');
let guests: typeof import('./guests');
let dbMod: typeof import('../db');

before(async () => {
  dbMod = await import('../db');
  auth = await import('../auth');
  guests = await import('./guests');
});

after(() => {
  dbMod?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('guest sessions', () => {
  it('refuses to create a session for a guest', () => {
    const { db, nowIso } = dbMod;
    const guestId = Number(
      db
        .prepare(
          `INSERT INTO users (shoo_sub, email, name, default_currency, created_at, is_guest)
           VALUES ('guest:abc', NULL, 'Ravi', 'INR', ?, 1)`,
        )
        .run(nowIso()).lastInsertRowid,
    );
    assert.throws(() => auth.assertCanHaveSession(guestId), /guests cannot sign in/);
    assert.throws(() => auth.assertCanHaveSession(999_999), /guests cannot sign in/);
    const realId = Number(
      db
        .prepare(
          `INSERT INTO users (shoo_sub, email, name, default_currency, created_at)
           VALUES ('pairwise-1', NULL, 'Asha', 'INR', ?)`,
        )
        .run(nowIso()).lastInsertRowid,
    );
    assert.doesNotThrow(() => auth.assertCanHaveSession(realId));
  });

  it('never maps a login to a guest subject', () => {
    assert.throws(() => auth.upsertUserFromClaims({ pairwise_sub: 'guest:abc' }), /invalid token/);
    assert.equal(auth.isGuestSub('guest:00'), true);
    assert.equal(auth.isGuestSub('pairwise-guest:00'), false);
  });
});

describe('remapTemplateUser', () => {
  const base = {
    description: 'Rent',
    amountCents: 900,
    currency: 'INR',
    category: 'home' as const,
    notes: null,
  };

  it('swaps the guest for the claimer', () => {
    const out = guests.remapTemplateUser(
      {
        ...base,
        split: {
          mode: 'equal',
          participants: [1, 7],
          payers: [{ userId: 7, cents: 900 }],
        },
      },
      7,
      3,
    );
    assert.deepEqual(out.split.participants, [1, 3]);
    assert.deepEqual(out.split.payers, [{ userId: 3, cents: 900 }]);
    assert.equal(out.split.values, undefined);
  });

  it('combines entries when the claimer is already in the split', () => {
    const out = guests.remapTemplateUser(
      {
        ...base,
        split: {
          mode: 'exact',
          participants: [1, 3, 7],
          values: [
            { userId: 1, value: 300 },
            { userId: 3, value: 200 },
            { userId: 7, value: 400 },
          ],
          payers: [
            { userId: 3, cents: 500 },
            { userId: 7, cents: 400 },
          ],
        },
      },
      7,
      3,
    );
    assert.deepEqual(out.split.participants, [1, 3]);
    assert.deepEqual(out.split.values, [
      { userId: 1, value: 300 },
      { userId: 3, value: 600 },
    ]);
    assert.deepEqual(out.split.payers, [{ userId: 3, cents: 900 }]);
  });
});
