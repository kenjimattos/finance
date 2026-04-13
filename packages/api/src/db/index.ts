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

  -- Credit (and eventually bank) accounts discovered from Pluggy. Each item
  -- may have multiple accounts (e.g. one CREDIT per brand/product). This is
  -- the anchor for per-account settings, groups, and bill windows.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    name TEXT,
    number TEXT,
    type TEXT,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(item_id);

  -- Per-account settings (closing/due day). Replaces the old per-item
  -- card_settings table. Each credit account under a Pluggy item can have
  -- its own billing cycle.
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id TEXT PRIMARY KEY,
    display_name TEXT,
    closing_day INTEGER NOT NULL,
    due_day INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
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
    card_last4 TEXT,                 -- last 4 digits of the physical card (from creditCardMetadata.cardNumber)
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

  -- User-defined groups of physical cards (e.g. "Eu + Esposa", "Virtual").
  -- Scoped per item so two connections can have their own "Esposa" group.
  CREATE TABLE IF NOT EXISTS card_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (item_id, name),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
  );

  -- Assignment of a physical card (identified by its last 4 digits) to a
  -- group. The composite primary key on (item_id, card_last4) enforces
  -- exclusivity at the schema level — a card can only be in one group.
  -- card_last4 is not globally unique (two banks may have the same last 4),
  -- so the item_id has to be part of the key.
  CREATE TABLE IF NOT EXISTS card_group_members (
    item_id TEXT NOT NULL,
    card_last4 TEXT NOT NULL,
    card_group_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (item_id, card_last4),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (card_group_id) REFERENCES card_groups(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cgm_group ON card_group_members(card_group_id);

  -- Manual bill-cycle shifts. A row here says "pretend this transaction
  -- belongs to a neighboring cycle instead of the one its date would
  -- naturally place it in". Used to fix cases where Pluggy reports a
  -- transaction with its purchase date, but the charge actually lands on
  -- a different bill (common for merchants that batch-submit days later).
  --
  -- shift values:
  --    -1  → one cycle EARLIER  ("this belongs to last month's bill")
  --    +1  → one cycle LATER    ("this belongs to next month's bill")
  --
  -- Higher magnitudes (±2, ±3) are allowed by the schema but the UI
  -- only exposes ±1 for now. A row with shift=0 is nonsensical and
  -- forbidden by the CHECK constraint.
  --
  -- Lives in its own table (not as a column on transactions) so that a
  -- re-sync from Pluggy never wipes the user's manual corrections. Same
  -- rationale as transaction_categories.
  CREATE TABLE IF NOT EXISTS transaction_bill_overrides (
    transaction_id TEXT PRIMARY KEY,
    shift INTEGER NOT NULL CHECK (shift <> 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );

  -- Manual recurring entries for cash-flow projection. Each row represents
  -- a monthly event (salary, rent, etc.) that lands on a fixed day. The
  -- cash-flow screen places these on future days of the current month.
  CREATE TABLE IF NOT EXISTS manual_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount REAL NOT NULL,           -- positive = income, negative = expense
    day_of_month INTEGER NOT NULL,  -- 1-31; clamped to actual month length at query time
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- User overrides for transaction descriptions. Allows renaming bank
  -- transactions (e.g. "PIX RECEBIDO CP 123" → "Salário") without
  -- mutating the Pluggy cache. Same join-table pattern as other overrides.
  CREATE TABLE IF NOT EXISTS transaction_description_overrides (
    transaction_id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );
`);

// -----------------------------------------------------------------------------
// Migrations
// -----------------------------------------------------------------------------
// SQLite's CREATE TABLE IF NOT EXISTS never adds columns to existing tables,
// so structural changes after the first boot have to run as idempotent
// ALTER TABLE steps. Each migration checks the current schema via
// PRAGMA table_info and only runs if the column is missing. Keep these
// append-only — never delete or edit past migrations, because someone's
// DB out there has already run them.
addColumnIfMissing('transactions', 'card_last4', 'TEXT');
addColumnIfMissing('transactions', 'amount_in_account_currency', 'REAL');

// Phase 5: add balance and subtype to accounts for BANK account support.
addColumnIfMissing('accounts', 'balance', 'REAL');
addColumnIfMissing('accounts', 'subtype', 'TEXT');

// Backfill balance and subtype from raw_json for existing accounts.
db.exec(`
  UPDATE accounts
  SET balance = json_extract(raw_json, '$.balance'),
      subtype = json_extract(raw_json, '$.subtype')
  WHERE balance IS NULL
    AND json_extract(raw_json, '$.balance') IS NOT NULL
`);

// Backfill amount_in_account_currency from raw_json for existing rows.
// Pluggy provides this field for foreign-currency transactions (e.g. USD
// purchases on a BRL account). Without it, USD amounts display as BRL.
db.exec(`
  UPDATE transactions
  SET amount_in_account_currency = json_extract(raw_json, '$.amountInAccountCurrency')
  WHERE amount_in_account_currency IS NULL
    AND json_extract(raw_json, '$.amountInAccountCurrency') IS NOT NULL
`);

// Fix transactions whose item_id drifted when the user deleted and
// re-connected the same bank (sandbox scenario). The account's item_id
// is authoritative — align transactions to match.
db.exec(`
  UPDATE transactions
  SET item_id = (SELECT a.item_id FROM accounts a WHERE a.id = transactions.account_id)
  WHERE EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = transactions.account_id AND a.item_id != transactions.item_id
  )
`);

// Re-enable all category rules that were auto-disabled by the old
// "2 overrides = disabled" logic. Rules now stay active regardless of
// override_count — the user corrects minority cases manually.
db.exec(`UPDATE category_rules SET disabled = 0 WHERE disabled = 1`);

// Backfill: transactions that have a non-numeric cardNumber in raw_json
// (e.g. "DIGITAL-PICPAY") were previously stored with card_last4 = NULL
// because lastFourDigits() only extracted numeric suffixes. The function
// now preserves non-numeric identifiers as-is (uppercased). This one-time
// UPDATE catches any rows synced before that fix landed.
db.exec(`
  UPDATE transactions
  SET card_last4 = UPPER(TRIM(json_extract(raw_json, '$.creditCardMetadata.cardNumber')))
  WHERE card_last4 IS NULL
    AND json_extract(raw_json, '$.creditCardMetadata.cardNumber') IS NOT NULL
    AND TRIM(json_extract(raw_json, '$.creditCardMetadata.cardNumber')) <> ''
`);

// Phase 2: backfill account_settings from card_settings for existing users.
// For each card_settings row, copy closing/due day to every CREDIT account
// under that item. Only runs when account_settings is empty and accounts
// have been synced. Idempotent — safe to re-run.
{
  const hasAccountSettings = db
    .prepare('SELECT COUNT(*) AS n FROM account_settings')
    .get() as { n: number };
  if (hasAccountSettings.n === 0) {
    const oldSettings = db
      .prepare('SELECT item_id, display_name, closing_day, due_day FROM card_settings')
      .all() as Array<{
      item_id: string;
      display_name: string | null;
      closing_day: number;
      due_day: number;
    }>;
    for (const s of oldSettings) {
      const accts = db
        .prepare("SELECT id FROM accounts WHERE item_id = ? AND type = 'CREDIT'")
        .all(s.item_id) as Array<{ id: string }>;
      for (const a of accts) {
        db.prepare(
          `INSERT OR IGNORE INTO account_settings
             (account_id, display_name, closing_day, due_day)
           VALUES (?, ?, ?, ?)`,
        ).run(a.id, s.display_name, s.closing_day, s.due_day);
      }
    }
  }
}

// Phase 2: add account_id to card_groups and card_group_members.
addColumnIfMissing('card_groups', 'account_id', 'TEXT');
addColumnIfMissing('card_group_members', 'account_id', 'TEXT');

// Backfill: for card_groups where account_id is NULL, look up the CREDIT
// account for the group's item_id. If there is exactly one, assign it.
{
  const nullGroups = db
    .prepare('SELECT id, item_id FROM card_groups WHERE account_id IS NULL')
    .all() as Array<{ id: number; item_id: string }>;
  for (const g of nullGroups) {
    const accts = db
      .prepare("SELECT id FROM accounts WHERE item_id = ? AND type = 'CREDIT'")
      .all(g.item_id) as Array<{ id: string }>;
    if (accts.length === 1) {
      db.prepare('UPDATE card_groups SET account_id = ? WHERE id = ?').run(
        accts[0].id,
        g.id,
      );
    }
  }
}

// Backfill card_group_members.account_id from the parent card_group.
db.exec(`
  UPDATE card_group_members
  SET account_id = (
    SELECT cg.account_id FROM card_groups cg WHERE cg.id = card_group_members.card_group_id
  )
  WHERE account_id IS NULL
`);

function addColumnIfMissing(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
