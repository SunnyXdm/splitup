import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const DB_PATH =
  process.env.DB_PATH ?? path.join(import.meta.dirname, '..', 'data', 'splitup.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  shoo_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT NOT NULL,
  picture TEXT,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS friendships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🧾',
  currency TEXT NOT NULL DEFAULT 'INR',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS group_invites (
  token TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_invites (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  notes TEXT,
  is_payment INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_group ON expenses(group_id);
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  paid_cents INTEGER NOT NULL DEFAULT 0,
  owed_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (expense_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_shares_user ON expense_shares(user_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  group_id INTEGER,
  expense_id INTEGER,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
`);

// Friend requests are addressed by email, not user id, so requests to
// unknown emails are stored too (and turn into incoming ones if that person
// signs up) — the sender can't tell whether an account exists. A pre-release
// id-keyed shape of this table never shipped; replace it if found.
const requestCols = db.prepare('PRAGMA table_info(friend_requests)').all() as { name: string }[];
if (requestCols.length > 0 && !requestCols.some((c) => c.name === 'to_email')) {
  db.exec('DROP TABLE friend_requests');
}
db.exec(`
CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_id, to_email)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_email);
`);

// Older databases predate soft-deleted groups; add the column in place.
const groupCols = db.prepare("PRAGMA table_info(groups)").all() as { name: string }[];
if (!groupCols.some((c) => c.name === 'deleted_at')) {
  db.exec('ALTER TABLE groups ADD COLUMN deleted_at TEXT');
}

// Idempotency keys for create retries (offline queue, flaky networks): one
// key per creator, so a replayed POST returns the original row.
const expenseCols = db.prepare("PRAGMA table_info(expenses)").all() as { name: string }[];
if (!expenseCols.some((c) => c.name === 'client_key')) {
  db.exec('ALTER TABLE expenses ADD COLUMN client_key TEXT');
}
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_client_key ON expenses(created_by, client_key) WHERE client_key IS NOT NULL',
);

// One settle-up = one batch: the cash that changed hands (net direction and
// amount) plus optional details, linking every payment row it was recorded
// as. Rows recorded before batches existed keep settlement_batch_id NULL.
db.exec(`
CREATE TABLE IF NOT EXISTS settlement_batches (
  id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  payer_id INTEGER NOT NULL REFERENCES users(id),
  payee_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlement_batches_payer ON settlement_batches(payer_id);
CREATE INDEX IF NOT EXISTS idx_settlement_batches_payee ON settlement_batches(payee_id);
`);
if (!expenseCols.some((c) => c.name === 'settlement_batch_id')) {
  db.exec(
    'ALTER TABLE expenses ADD COLUMN settlement_batch_id INTEGER REFERENCES settlement_batches(id)',
  );
}
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_expenses_settlement_batch ON expenses(settlement_batch_id) WHERE settlement_batch_id IS NOT NULL',
);

// Small key/value store for server-generated config (e.g. VAPID keys) that
// must survive restarts.
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
`);

// Expense revision history: one immutable snapshot per change, written in the
// same transaction as the change itself. The snapshot is the expense's
// user-facing state as JSON, built by SQLite from the live row (SNAPSHOT_SQL)
// so every writer — routes, backfill, scripts — produces the same shape.
db.exec(`
CREATE TABLE IF NOT EXISTS expense_revisions (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'restored')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (expense_id, revision)
);
`);

/** SQL expression for the snapshot JSON of the expenses row aliased `e`. */
export const SNAPSHOT_SQL = `json_object(
  'description', e.description,
  'amountCents', e.amount_cents,
  'currency', e.currency,
  'date', e.date,
  'category', e.category,
  'notes', e.notes,
  'groupId', e.group_id,
  'isPayment', json(CASE WHEN e.is_payment THEN 'true' ELSE 'false' END),
  'shares', (
    SELECT json_group_array(
      json_object('userId', s.user_id, 'paidCents', s.paid_cents, 'owedCents', s.owed_cents)
    )
    FROM (SELECT * FROM expense_shares WHERE expense_id = e.id ORDER BY user_id) s
  )
)`;

/**
 * Backfill for expenses that predate revisions: a 'created' snapshot of the
 * current state (attributed to the creator, at created_at), then a 'deleted'
 * entry for soft-deleted ones whose history doesn't already end in one
 * (attributed to whoever the activity feed says deleted it, else the
 * creator). Every live writer records its own revisions, so re-running
 * matches nothing.
 */
export function backfillRevisions(): void {
  db.transaction(() => {
    db.exec(`
      INSERT INTO expense_revisions (expense_id, revision, action, actor_id, snapshot, created_at)
      SELECT e.id, 1, 'created', e.created_by, ${SNAPSHOT_SQL}, e.created_at
      FROM expenses e
      WHERE NOT EXISTS (SELECT 1 FROM expense_revisions r WHERE r.expense_id = e.id);

      INSERT INTO expense_revisions (expense_id, revision, action, actor_id, snapshot, created_at)
      SELECT e.id,
        (SELECT MAX(r.revision) FROM expense_revisions r WHERE r.expense_id = e.id) + 1,
        'deleted',
        COALESCE(
          (SELECT a.actor_id FROM activity a
           WHERE a.expense_id = e.id AND a.type IN ('expense_deleted', 'payment_undone')
           ORDER BY a.id DESC LIMIT 1),
          e.created_by
        ),
        ${SNAPSHOT_SQL}, e.deleted_at
      FROM expenses e
      WHERE e.deleted_at IS NOT NULL
        AND (
          SELECT r.action FROM expense_revisions r WHERE r.expense_id = e.id
          ORDER BY r.revision DESC LIMIT 1
        ) IS NOT 'deleted';
    `);
  })();
}
backfillRevisions();

export interface UserRow {
  id: number;
  shoo_sub: string;
  email: string | null;
  name: string;
  picture: string | null;
  default_currency: string;
  created_at: string;
}
export interface GroupRow {
  id: number;
  name: string;
  emoji: string;
  currency: string;
  created_by: number;
  created_at: string;
  deleted_at: string | null;
}
export interface ExpenseRow {
  id: number;
  group_id: number | null;
  description: string;
  amount_cents: number;
  currency: string;
  date: string;
  category: string;
  notes: string | null;
  is_payment: number;
  created_by: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  client_key: string | null;
  settlement_batch_id: number | null;
}
export interface SettlementBatchRow {
  id: number;
  created_by: number;
  payer_id: number;
  payee_id: number;
  amount_cents: number;
  currency: string;
  date: string;
  method: string | null;
  reference: string | null;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
}
export interface ShareRow {
  expense_id: number;
  user_id: number;
  paid_cents: number;
  owed_cents: number;
}
export interface ActivityRow {
  id: number;
  actor_id: number;
  type: string;
  group_id: number | null;
  expense_id: number | null;
  summary: string;
  created_at: string;
}

export interface ExpenseRevisionRow {
  id: number;
  expense_id: number;
  revision: number;
  action: 'created' | 'updated' | 'deleted' | 'restored';
  actor_id: number;
  snapshot: string;
  created_at: string;
}

export interface FriendRequestRow {
  id: number;
  from_id: number;
  to_email: string;
  created_at: string;
}

export const nowIso = () => new Date().toISOString();

// SQLite only folds the WAL back into the main file opportunistically, so
// without this the -wal file holds days of committed data and a copy of
// splitup.db alone is stale. TRUNCATE also shrinks the -wal file to zero.
export function checkpoint(): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP = 7;

/**
 * Consistent daily snapshot (online backup API), keeping the newest 7. Written
 * to a .tmp file and renamed into place, so a crash or shutdown mid-backup
 * never leaves a truncated snapshot under a real backup name.
 */
export async function backupDaily(): Promise<void> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `splitup-${nowIso().slice(0, 10)}.db`);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  await db.backup(tmp);
  renameSync(tmp, file);
  const old = readdirSync(BACKUP_DIR)
    .filter((f) => /^splitup-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -BACKUP_KEEP);
  for (const f of old) rmSync(path.join(BACKUP_DIR, f));
}
