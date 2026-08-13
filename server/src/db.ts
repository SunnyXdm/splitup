import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
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

// Older databases predate soft-deleted groups; add the column in place.
const groupCols = db.prepare("PRAGMA table_info(groups)").all() as { name: string }[];
if (!groupCols.some((c) => c.name === 'deleted_at')) {
  db.exec('ALTER TABLE groups ADD COLUMN deleted_at TEXT');
}

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

export const nowIso = () => new Date().toISOString();
