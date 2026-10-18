import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The user_version 2 migration folds the 1:1 user-work join tables into
 * columns of `transactions` / `bank_transactions` and drops them. These tests
 * open real database files through initDb, so the whole schema + migration
 * sequence runs exactly as it does on boot.
 *
 * config.ts validates the environment on import, and dotenv never overrides a
 * variable that is already set, so DATABASE_DIR is pointed at a temp dir
 * before the dynamic import — the real data directory is never touched.
 */
const dir = mkdtempSync(join(tmpdir(), 'finance-migration-'));
process.env.DATABASE_DIR = dir;
process.env.PLUGGY_CLIENT_ID ??= 'test';
process.env.PLUGGY_CLIENT_SECRET ??= 'test';
const { initDb, runLegacySchema } = await import('./index.js');

after(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_TABLES = [
  'transaction_categories',
  'transaction_bill_overrides',
  'transaction_splits',
  'transaction_hidden',
  'transaction_description_overrides',
  'bank_transaction_description_overrides',
  'bank_bill_payment_tags',
  'bank_transaction_hidden',
  'bill_payment_tags',
  'card_settings',
];

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
}

/** A database as it looked at user_version 1: user work in join tables. */
function createVersion1(path: string): void {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, connector_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE accounts (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, name TEXT, number TEXT,
      type TEXT, raw_json TEXT NOT NULL, synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE);
    CREATE TABLE account_settings (account_id TEXT PRIMARY KEY, display_name TEXT,
      closing_day INTEGER NOT NULL, due_day INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
    CREATE TABLE user_categories (id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, provider_transaction_id TEXT, account_id TEXT NOT NULL,
      item_id TEXT NOT NULL, date TEXT NOT NULL, description TEXT, amount REAL NOT NULL,
      currency_code TEXT, pluggy_category TEXT, pluggy_category_id TEXT, type TEXT, status TEXT,
      installment_number INTEGER, total_installments INTEGER, bill_id TEXT, card_last4 TEXT,
      amount_in_account_currency REAL, source TEXT NOT NULL DEFAULT 'pluggy', identity_hash TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      raw_json TEXT NOT NULL, synced_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE bank_transactions (
      id TEXT PRIMARY KEY, provider_transaction_id TEXT, account_id TEXT NOT NULL,
      item_id TEXT NOT NULL, date TEXT NOT NULL, description TEXT, amount REAL NOT NULL,
      currency_code TEXT, pluggy_category TEXT, pluggy_category_id TEXT, type TEXT, status TEXT,
      raw_json TEXT NOT NULL, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at TEXT NOT NULL DEFAULT (datetime('now')), sort_key REAL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
  `);
  runLegacySchema(db);
  db.exec(`
    INSERT INTO items (id) VALUES ('item');
    INSERT INTO accounts (id, item_id, type, raw_json) VALUES ('card', 'item', 'CREDIT', '{}');
    INSERT INTO accounts (id, item_id, type, raw_json) VALUES ('bank', 'item', 'BANK', '{}');
    INSERT INTO account_settings (account_id, closing_day, due_day) VALUES ('card', 16, 25);
    INSERT INTO card_settings (item_id, closing_day, due_day) VALUES ('item', 16, 25);
    INSERT INTO user_categories (id, name, color) VALUES (7, 'Casa', '#000');

    INSERT INTO transactions (id, provider_transaction_id, account_id, item_id, date, amount, source, raw_json)
    VALUES ('worked', 'p1', 'card', 'item', '2026-09-10', 50, 'pluggy', '{}'),
           ('plain',  'p2', 'card', 'item', '2026-09-11', 20, 'pluggy', '{}');
    INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by, assigned_at)
    VALUES ('worked', 7, 'bulk', '2026-09-12 08:00:00');
    INSERT INTO transaction_bill_overrides (transaction_id, shift) VALUES ('worked', -1);
    INSERT INTO transaction_splits (transaction_id, split_type) VALUES ('worked', 'theirs');
    INSERT INTO transaction_hidden (transaction_id, created_at) VALUES ('worked', '2026-09-13 09:00:00');
    INSERT INTO transaction_description_overrides (transaction_id, description) VALUES ('worked', 'Mercado');

    INSERT INTO bank_transactions (id, provider_transaction_id, account_id, item_id, date, amount, raw_json)
    VALUES ('b-worked', 'bp1', 'bank', 'item', '2026-09-10', -900, '{}'),
           ('b-plain',  'bp2', 'bank', 'item', '2026-09-11', -10, '{}');
    INSERT INTO bank_transaction_description_overrides (transaction_id, description) VALUES ('b-worked', 'Fatura Itaú');
    INSERT INTO bank_bill_payment_tags (transaction_id, created_at) VALUES ('b-worked', '2026-09-14 10:00:00');
    INSERT INTO bank_transaction_hidden (transaction_id, created_at) VALUES ('b-worked', '2026-09-15 11:00:00');
  `);
  db.pragma('user_version = 1');
  db.close();
}

describe('user_version 2 migration', () => {
  it('moves user work into columns and drops the join tables', () => {
    const path = join(dir, 'v1.sqlite');
    createVersion1(path);

    const db = initDb(path);

    assert.equal(db.pragma('user_version', { simple: true }), 2);
    const present = tables(db);
    for (const t of LEGACY_TABLES) assert.ok(!present.includes(t), `${t} should be dropped`);

    const tx = db
      .prepare(
        `SELECT id, category_id, category_assigned_by, category_assigned_at, bill_shift,
                split_type, hidden_at, description_override
         FROM transactions ORDER BY id`,
      )
      .all();
    assert.deepEqual(tx, [
      {
        id: 'plain', category_id: null, category_assigned_by: null, category_assigned_at: null,
        bill_shift: null, split_type: null, hidden_at: null, description_override: null,
      },
      {
        id: 'worked', category_id: 7, category_assigned_by: 'bulk',
        category_assigned_at: '2026-09-12 08:00:00', bill_shift: -1, split_type: 'theirs',
        hidden_at: '2026-09-13 09:00:00', description_override: 'Mercado',
      },
    ]);

    const bank = db
      .prepare(
        `SELECT id, description_override, bill_payment_tagged_at, hidden_at
         FROM bank_transactions ORDER BY id`,
      )
      .all();
    assert.deepEqual(bank, [
      { id: 'b-plain', description_override: null, bill_payment_tagged_at: null, hidden_at: null },
      {
        id: 'b-worked', description_override: 'Fatura Itaú',
        bill_payment_tagged_at: '2026-09-14 10:00:00', hidden_at: '2026-09-15 11:00:00',
      },
    ]);
    db.close();
  });

  it('is a no-op on the next open', () => {
    const path = join(dir, 'v1.sqlite');
    const db = initDb(path);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.equal(
      (db.prepare(`SELECT category_id FROM transactions WHERE id = 'worked'`).get() as { category_id: number }).category_id,
      7,
    );
    db.close();
  });

  it('a brand-new database ends in the final shape', () => {
    const db = initDb(join(dir, 'fresh.sqlite'));
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    const present = tables(db);
    for (const t of LEGACY_TABLES) assert.ok(!present.includes(t), `${t} should not exist`);
    const cols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['category_id', 'bill_shift', 'split_type', 'hidden_at', 'description_override']) {
      assert.ok(cols.includes(c), `transactions.${c}`);
    }
    db.close();
  });

  it('deleting a category clears category_id through the FK', () => {
    const db = initDb(join(dir, 'fresh.sqlite'));
    db.exec(`
      INSERT INTO user_categories (id, name, color) VALUES (1, 'Lazer', '#000');
      INSERT INTO transactions (id, account_id, item_id, date, amount, raw_json, category_id)
      VALUES ('t', 'a', 'i', '2026-09-10', 1, '{}', 1);
      DELETE FROM user_categories WHERE id = 1;
    `);
    assert.equal(
      (db.prepare(`SELECT category_id FROM transactions WHERE id = 't'`).get() as { category_id: unknown }).category_id,
      null,
    );
    db.close();
  });
});
