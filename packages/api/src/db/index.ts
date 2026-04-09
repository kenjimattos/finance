import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = 'data/finance.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    connector_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    currency_code TEXT,
    category TEXT,
    category_id TEXT,
    type TEXT,
    status TEXT,
    installment_number INTEGER,
    total_installments INTEGER,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
`);
