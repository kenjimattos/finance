import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = 'data/finance.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Bank connections ("items" in Pluggy's lingo). One row per linked card.
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    connector_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-card settings the user must fill in manually. Pluggy does not expose
  -- closing/due days, so we derive the "currently open bill" window from these.
  CREATE TABLE IF NOT EXISTS card_settings (
    item_id TEXT PRIMARY KEY,
    display_name TEXT,
    closing_day INTEGER NOT NULL,   -- day of month the bill closes (e.g. 16)
    due_day INTEGER NOT NULL,       -- day of month the bill is due   (e.g. 25)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  );

  -- Raw transactions cache from Pluggy. raw_json keeps the full payload so
  -- new fields can be surfaced later without a backfill.
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    currency_code TEXT,
    pluggy_category TEXT,            -- Pluggy's auto-categorization (informational)
    pluggy_category_id TEXT,
    type TEXT,
    status TEXT,
    installment_number INTEGER,
    total_installments INTEGER,
    bill_id TEXT,                    -- only set once the bill closes (Pluggy limitation)
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_bill ON transactions(bill_id);

  -- Closed bills cache (open bills are computed, not stored).
  CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    due_date TEXT NOT NULL,
    total_amount REAL NOT NULL,
    currency_code TEXT,
    minimum_payment REAL,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bills_item ON bills(item_id);
  CREATE INDEX IF NOT EXISTS idx_bills_due ON bills(due_date);

  -- User-defined categories (flat, not hierarchical). Colors are assigned
  -- automatically from a curated palette at creation time.
  CREATE TABLE IF NOT EXISTS user_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Join table: transaction → user category. Separate from transactions so
  -- that re-syncing from Pluggy never wipes the user's work.
  CREATE TABLE IF NOT EXISTS transaction_categories (
    transaction_id TEXT PRIMARY KEY,
    user_category_id INTEGER NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_by TEXT NOT NULL,       -- 'manual' | 'bulk' | 'learned'
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_category_id) REFERENCES user_categories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tc_category ON transaction_categories(user_category_id);

  -- Auto-learned rules. Each row says "when a new transaction's merchant slug
  -- matches X, auto-apply category Y". hit_count lets us rank by confidence;
  -- override_count is bumped when the user manually changes an auto-applied
  -- categorization — 2 overrides disables the rule.
  CREATE TABLE IF NOT EXISTS category_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_category_id INTEGER NOT NULL,
    merchant_slug TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1,
    override_count INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (merchant_slug, user_category_id),
    FOREIGN KEY (user_category_id) REFERENCES user_categories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_rules_slug ON category_rules(merchant_slug);
`);
