import Database, { type Database as Db } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type { Db };

// Per-user handle cache. Each username maps to its own SQLite file under
// DATABASE_DIR; the file is opened on first request and the handle is
// cached for the lifetime of the process. better-sqlite3 connections are
// synchronous and thread-safe within a single process, so a Map is enough
// — no pooling needed.
const handles = new Map<string, Db>();

mkdirSync(config.DATABASE_DIR, { recursive: true });

export function getDb(username: string): Db {
  const cached = handles.get(username);
  if (cached) return cached;
  const filePath = join(config.DATABASE_DIR, `${username}.sqlite`);
  const handle = initDb(filePath);
  handles.set(username, handle);
  return handle;
}

function initDb(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runSchema(db);
  runMigrations(db);
  return db;
}

function runSchema(db: Db): void {
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
  --
  -- id is a local application UUID (stable, never changes). provider_transaction_id
  -- holds the Pluggy-issued ID, which may be recycled across different purchases.
  -- identity_hash is SHA-256(account+date+amount+merchant_slug) and lets sync
  -- detect when Pluggy reuses an ID for a materially different transaction.
  CREATE TABLE IF NOT EXISTS transactions (
    id                         TEXT PRIMARY KEY,
    provider_transaction_id    TEXT,
    account_id                 TEXT NOT NULL,
    item_id                    TEXT NOT NULL,
    date                       TEXT NOT NULL,
    description                TEXT,
    amount                     REAL NOT NULL,
    currency_code              TEXT,
    pluggy_category            TEXT,
    pluggy_category_id         TEXT,
    type                       TEXT,
    status                     TEXT,
    installment_number         INTEGER,
    total_installments         INTEGER,
    bill_id                    TEXT,
    card_last4                 TEXT,
    amount_in_account_currency REAL,
    source                     TEXT NOT NULL DEFAULT 'pluggy',
    identity_hash              TEXT,
    first_seen_at              TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at               TEXT NOT NULL DEFAULT (datetime('now')),
    raw_json                   TEXT NOT NULL,
    synced_at                  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_tx_item    ON transactions(item_id);
  CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_bill    ON transactions(bill_id);

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

  -- Balance snapshots: a raw, write-only DIAGNOSTIC log of the Pluggy-reported
  -- balance at each sync. One row per (account, date). NOT used for balance
  -- math — that field oscillates wildly for some connectors (see balance_anchors),
  -- so the opening balance is grounded on a confirmed anchor instead. Kept only
  -- to audit/inspect connector behaviour over time (it's what surfaced the
  -- Nubank balance oscillation in the first place).
  CREATE TABLE IF NOT EXISTS balance_snapshots (
    account_id TEXT NOT NULL,
    date TEXT NOT NULL,              -- yyyy-mm-dd of the sync
    balance REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, date),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- User-confirmed balance anchor: a TRUSTED absolute balance at a known date,
  -- used to ground the CashFlow running balance instead of Pluggy's live
  -- balance field (which oscillates wildly for some connectors). The opening
  -- balance of every month is derived from the single most recent anchor by
  -- walking the transaction history forward/backward, so the displayed saldo is
  -- consistent regardless of which months are loaded and immune to a bad Pluggy
  -- reading. Refreshed at each year-end (a new anchor row), older rows kept for
  -- audit. Absent → fall back to the live balance. Distinct from
  -- balance_snapshots, which are raw (untrusted) per-sync readings never used
  -- for balance math.
  CREATE TABLE IF NOT EXISTS balance_anchors (
    account_id TEXT NOT NULL,
    anchor_date TEXT NOT NULL,       -- yyyy-mm-dd; balance is as of END of this day
    balance REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'pluggy' | ...
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, anchor_date),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  -- Manual tag: marks a BANK transaction as a credit card bill payment.
  -- Used by the Overview to compute the faturas total when the auto-detection
  -- (matching "FATURA"/"INT" in description) doesn't catch a payment.
  CREATE TABLE IF NOT EXISTS bill_payment_tags (
    transaction_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );

  -- Bill-splitting: marks a transaction as shared with a partner.
  -- 'half' = 50/50 split (partner owes half), 'theirs' = partner owes 100%.
  -- Categorized transactions WITHOUT a split row are implicitly "mine".
  CREATE TABLE IF NOT EXISTS transaction_splits (
    transaction_id TEXT PRIMARY KEY,
    split_type TEXT NOT NULL CHECK(split_type IN ('half', 'theirs')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );

  -- Hide-from-bill: the user marks a transaction as "not real" (phantom rows
  -- minted from corrupted Pluggy payloads, connector duplicates). Hidden rows
  -- are excluded from every bill total / breakdown / split / reconcile query
  -- but still returned (flagged) by GET /transactions so the action is
  -- visible and reversible in the inbox. Unlike removing the category, hiding
  -- is stable across re-syncs: applyLearnedRules skips hidden rows, so a
  -- learned rule can never pull a hidden transaction back into the totals.
  CREATE TABLE IF NOT EXISTS transaction_hidden (
    transaction_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
  );

  -- Audit log for anomalous Pluggy payloads detected during sync.
  --   kind = 'recycled':            provider_transaction_id was reused for a
  --                                 materially different purchase. Old row kept
  --                                 intact; new payload minted as a separate row
  --                                 (new_transaction_id).
  --   kind = 'mutation-suppressed': Pluggy rewrote an existing record in place
  --                                 (corrupted half-mutation or an implausible
  --                                 date jump). Nothing was minted —
  --                                 new_transaction_id is NULL; the payload was
  --                                 absorbed into the kept row's raw_json only.
  CREATE TABLE IF NOT EXISTS transaction_sync_conflicts (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_transaction_id TEXT NOT NULL,
    kept_transaction_id     TEXT NOT NULL,
    new_transaction_id      TEXT,
    kind                    TEXT NOT NULL DEFAULT 'recycled',
    old_payload_json        TEXT NOT NULL,
    new_payload_json        TEXT NOT NULL,
    detected_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- BANK transactions live in their own table because their identity model
  -- differs from credit cards. Pluggy provider_transaction_id is the only
  -- stable identity signal for BANK (no installment refreshes, no observed
  -- ID recycling); descriptions and dates can drift between syncs as Pluggy
  -- enriches metadata. The cashflow sync trusts provider_id and overwrites
  -- mutable fields in place — no hash machinery, no recycled ID branch.
  -- Schema is intentionally narrower than transactions: no installment,
  -- bill, or card columns, no identity_hash, no source.
  CREATE TABLE IF NOT EXISTS bank_transactions (
    id                      TEXT PRIMARY KEY,
    provider_transaction_id TEXT,
    account_id              TEXT NOT NULL,
    item_id                 TEXT NOT NULL,
    date                    TEXT NOT NULL,
    description             TEXT,
    amount                  REAL NOT NULL,
    currency_code           TEXT,
    pluggy_category         TEXT,
    pluggy_category_id      TEXT,
    type                    TEXT,
    status                  TEXT,
    raw_json                TEXT NOT NULL,
    first_seen_at           TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at            TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at               TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_bank_tx_account  ON bank_transactions(account_id);
  CREATE INDEX IF NOT EXISTS idx_bank_tx_item     ON bank_transactions(item_id);
  CREATE INDEX IF NOT EXISTS idx_bank_tx_date     ON bank_transactions(date);
  CREATE INDEX IF NOT EXISTS idx_bank_tx_provider ON bank_transactions(provider_transaction_id);

  -- Sister tables for user work attached to BANK rows.
  CREATE TABLE IF NOT EXISTS bank_transaction_description_overrides (
    transaction_id TEXT PRIMARY KEY,
    description    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bank_bill_payment_tags (
    transaction_id TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE
  );

  -- Hide flag for bank rows the user knows are visual duplicates (e.g. the
  -- bank reported the same charge twice with different metadata, and Pluggy
  -- passed both through as distinct provider_ids). Rows here are excluded
  -- from /cashflow but kept in bank_transactions so subsequent syncs still
  -- touch them (and so balance math stays consistent).
  CREATE TABLE IF NOT EXISTS bank_transaction_hidden (
    transaction_id TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE
  );
`);
}

function runMigrations(db: Db): void {

// -----------------------------------------------------------------------------
// Migrations
// -----------------------------------------------------------------------------
// SQLite's CREATE TABLE IF NOT EXISTS never adds columns to existing tables,
// so structural changes after the first boot have to run as idempotent
// ALTER TABLE steps. Each migration checks the current schema via
// PRAGMA table_info and only runs if the column is missing. Keep these
// append-only — never delete or edit past migrations, because someone's
// DB out there has already run them.
addColumnIfMissing(db, 'transactions', 'card_last4', 'TEXT');
addColumnIfMissing(db, 'transactions', 'amount_in_account_currency', 'REAL');
addColumnIfMissing(db, 'manual_entries', 'month', 'TEXT');

// Backfill: assign existing month-less manual entries to the current month.
// Manual entries are now per-month (independent editing). Legacy rows without
// a month get pinned to today's month so they don't appear in every month.
{
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  db.prepare(`UPDATE manual_entries SET month = ? WHERE month IS NULL`).run(currentMonth);
}

// Phase 5: add balance and subtype to accounts for BANK account support.
addColumnIfMissing(db, 'accounts', 'balance', 'REAL');
addColumnIfMissing(db, 'accounts', 'subtype', 'TEXT');

// sort_key for user-controlled ordering within the cashflow day grouping.
// NULL means "use the natural order" (bank_transactions: id ASC; manual_entries: id ASC).
// Set to a fractional REAL when the user drags a row; new positions are placed
// midway between neighbors so any sequence of drags stays representable.
addColumnIfMissing(db, 'bank_transactions', 'sort_key', 'REAL');
addColumnIfMissing(db, 'manual_entries', 'sort_key', 'REAL');

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

// Source column distinguishes Pluggy-synced transactions from manual entries
// added by the user. Manual entries persist across re-syncs and can be
// edited/deleted via the API.
addColumnIfMissing(db, 'transactions', 'source', "TEXT DEFAULT 'pluggy'");

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
addColumnIfMissing(db, 'card_groups', 'account_id', 'TEXT');
addColumnIfMissing(db, 'card_group_members', 'account_id', 'TEXT');

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

// Migration: transaction_sync_conflicts gains a `kind` column and a nullable
// new_transaction_id (mutation-suppressed conflicts don't mint a row). The
// kind column doubles as the migration marker; existing rows are all
// recycled-ID conflicts, which DEFAULT 'recycled' labels correctly.
{
  const cols = db
    .prepare(`PRAGMA table_info(transaction_sync_conflicts)`)
    .all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === 'kind')) {
    db.exec(`
      ALTER TABLE transaction_sync_conflicts RENAME TO _tsc_old;
      CREATE TABLE transaction_sync_conflicts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_transaction_id TEXT NOT NULL,
        kept_transaction_id     TEXT NOT NULL,
        new_transaction_id      TEXT,
        kind                    TEXT NOT NULL DEFAULT 'recycled',
        old_payload_json        TEXT NOT NULL,
        new_payload_json        TEXT NOT NULL,
        detected_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transaction_sync_conflicts
        (id, provider_transaction_id, kept_transaction_id, new_transaction_id,
         kind, old_payload_json, new_payload_json, detected_at)
      SELECT id, provider_transaction_id, kept_transaction_id, new_transaction_id,
             'recycled', old_payload_json, new_payload_json, detected_at
      FROM _tsc_old;
      DROP TABLE _tsc_old;
    `);
  }
}

// Migration: if transaction_splits has the old 'mine' CHECK constraint,
// recreate without it and delete any 'mine' rows (they are now implicit).
{
  const checkSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transaction_splits'")
    .get() as { sql: string } | undefined;
  if (checkSql && checkSql.sql.includes("'mine'")) {
    db.exec(`
      DELETE FROM transaction_splits WHERE split_type = 'mine';
      ALTER TABLE transaction_splits RENAME TO _transaction_splits_old;
      CREATE TABLE transaction_splits (
        transaction_id TEXT PRIMARY KEY,
        split_type TEXT NOT NULL CHECK(split_type IN ('half', 'theirs')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      );
      INSERT INTO transaction_splits SELECT * FROM _transaction_splits_old;
      DROP TABLE _transaction_splits_old;
    `);
  }
}

// Migration: replace Pluggy UUID primary key with local application UUID.
//
// Pluggy recycles transaction IDs when old transactions fall off their cache,
// silently mapping a new purchase to an old row — destroying categories, splits,
// and bill overrides the user already applied. By making `id` a locally-generated
// UUID and moving the Pluggy ID to `provider_transaction_id`, two rows can
// legitimately coexist under the same external ID without corrupting each other.
//
// Guard: if `provider_transaction_id` already exists, migration is complete.
{
  const txCols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map(
    (r) => r.name,
  );
  if (!txCols.includes('provider_transaction_id')) {
    // Step 1 — add a temporary column for the new local UUIDs.
    if (!txCols.includes('_new_id')) {
      db.exec('ALTER TABLE transactions ADD COLUMN _new_id TEXT');
    }

    // Step 2 — backfill _new_id for every row that doesn't have one yet.
    // Done in JS so we get proper v4 UUIDs rather than SQLite's random bytes.
    const missing = db
      .prepare('SELECT id FROM transactions WHERE _new_id IS NULL')
      .all() as { id: string }[];
    if (missing.length > 0) {
      const setId = db.prepare('UPDATE transactions SET _new_id = ? WHERE id = ?');
      db.transaction(() => {
        for (const row of missing) setId.run(randomUUID(), row.id);
      })();
    }

    // Steps 3–5 require FK enforcement off: the FK tables will temporarily
    // point to UUIDs that don't yet exist in the rebuilt `transactions` table.
    db.pragma('foreign_keys = OFF');
    try {
      // Step 3 — repoint every FK table from the old Pluggy UUID → new local UUID.
      db.exec(`
        UPDATE transaction_categories
        SET transaction_id = (
          SELECT _new_id FROM transactions WHERE id = transaction_categories.transaction_id
        )
        WHERE transaction_id IN (SELECT id FROM transactions WHERE _new_id IS NOT NULL);

        UPDATE transaction_bill_overrides
        SET transaction_id = (
          SELECT _new_id FROM transactions WHERE id = transaction_bill_overrides.transaction_id
        )
        WHERE transaction_id IN (SELECT id FROM transactions WHERE _new_id IS NOT NULL);

        UPDATE transaction_description_overrides
        SET transaction_id = (
          SELECT _new_id FROM transactions WHERE id = transaction_description_overrides.transaction_id
        )
        WHERE transaction_id IN (SELECT id FROM transactions WHERE _new_id IS NOT NULL);

        UPDATE bill_payment_tags
        SET transaction_id = (
          SELECT _new_id FROM transactions WHERE id = bill_payment_tags.transaction_id
        )
        WHERE transaction_id IN (SELECT id FROM transactions WHERE _new_id IS NOT NULL);

        UPDATE transaction_splits
        SET transaction_id = (
          SELECT _new_id FROM transactions WHERE id = transaction_splits.transaction_id
        )
        WHERE transaction_id IN (SELECT id FROM transactions WHERE _new_id IS NOT NULL);
      `);

      // Step 4 — rebuild transactions with the new schema, then swap tables.
      // _new_id becomes `id`; old `id` (Pluggy UUID) moves to provider_transaction_id
      // (NULL for manual transactions, which were never keyed by a Pluggy ID).
      db.exec(`
        CREATE TABLE transactions_v2 (
          id                         TEXT PRIMARY KEY,
          provider_transaction_id    TEXT,
          account_id                 TEXT NOT NULL,
          item_id                    TEXT NOT NULL,
          date                       TEXT NOT NULL,
          description                TEXT,
          amount                     REAL NOT NULL,
          currency_code              TEXT,
          pluggy_category            TEXT,
          pluggy_category_id         TEXT,
          type                       TEXT,
          status                     TEXT,
          installment_number         INTEGER,
          total_installments         INTEGER,
          bill_id                    TEXT,
          card_last4                 TEXT,
          amount_in_account_currency REAL,
          source                     TEXT NOT NULL DEFAULT 'pluggy',
          identity_hash              TEXT,
          first_seen_at              TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at               TEXT NOT NULL DEFAULT (datetime('now')),
          raw_json                   TEXT NOT NULL,
          synced_at                  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO transactions_v2
          (id, provider_transaction_id, account_id, item_id, date, description,
           amount, currency_code, pluggy_category, pluggy_category_id, type, status,
           installment_number, total_installments, bill_id, card_last4,
           amount_in_account_currency, source, raw_json, synced_at)
        SELECT
          _new_id,
          CASE WHEN COALESCE(source, 'pluggy') = 'manual' THEN NULL ELSE id END,
          account_id, item_id, date, description, amount, currency_code,
          pluggy_category, pluggy_category_id, type, status,
          installment_number, total_installments, bill_id, card_last4,
          amount_in_account_currency, COALESCE(source, 'pluggy'),
          raw_json, synced_at
        FROM transactions;

        DROP TABLE transactions;
        ALTER TABLE transactions_v2 RENAME TO transactions;

        CREATE INDEX IF NOT EXISTS idx_tx_account  ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_tx_item     ON transactions(item_id);
        CREATE INDEX IF NOT EXISTS idx_tx_date     ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_tx_bill     ON transactions(bill_id);
        CREATE INDEX IF NOT EXISTS idx_tx_provider ON transactions(provider_transaction_id);
      `);
    } finally {
      // Always re-enable FK enforcement, even if migration fails midway.
      db.pragma('foreign_keys = ON');
    }
  }
}

// Create the provider_transaction_id index unconditionally after migration.
// For existing DBs the migration just created it; for brand-new DBs the
// initial CREATE TABLE already has the column and this is the first chance
// to create the index (it can't live in the initial db.exec() block because
// for existing DBs the column doesn't exist until migration runs).
db.exec(
  'CREATE INDEX IF NOT EXISTS idx_tx_provider ON transactions(provider_transaction_id)',
);

// Migration: split BANK transactions out of `transactions` into the dedicated
// `bank_transactions` table. The two domains have different identity models
// (see the table comment) and were entangled in the cashflow sync, causing
// false-positive "recycled ID" duplicates when Pluggy enriched descriptions
// between syncs. Moving BANK to its own table with a naive provider_id-based
// sync isolates the problem and lets us observe Pluggy's BANK behavior
// without affecting the credit-card path.
//
// Idempotency: only runs while BANK rows still exist in `transactions`.
// Re-running after a successful split is a no-op.
{
  const bankInOld = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE account_id IN (SELECT id FROM accounts WHERE type = 'BANK')`,
    )
    .get() as { n: number };

  if (bankInOld.n > 0) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        // Step 1 — copy BANK rows into bank_transactions, preserving ids.
        db.exec(`
          INSERT INTO bank_transactions
            (id, provider_transaction_id, account_id, item_id, date, description,
             amount, currency_code, pluggy_category, pluggy_category_id,
             type, status, raw_json, first_seen_at, last_seen_at, synced_at)
          SELECT
            id, provider_transaction_id, account_id, item_id, date, description,
            amount, currency_code, pluggy_category, pluggy_category_id,
            type, status, raw_json, first_seen_at, last_seen_at, synced_at
          FROM transactions
          WHERE account_id IN (SELECT id FROM accounts WHERE type = 'BANK')
            AND COALESCE(source, 'pluggy') = 'pluggy';
        `);

        // Step 2 — move FK rows pointing at the migrated BANK transactions.
        db.exec(`
          INSERT OR IGNORE INTO bank_transaction_description_overrides
            (transaction_id, description, created_at)
          SELECT o.transaction_id, o.description, o.created_at
          FROM transaction_description_overrides o
          WHERE o.transaction_id IN (SELECT id FROM bank_transactions);

          DELETE FROM transaction_description_overrides
          WHERE transaction_id IN (SELECT id FROM bank_transactions);

          INSERT OR IGNORE INTO bank_bill_payment_tags
            (transaction_id, created_at)
          SELECT t.transaction_id, t.created_at
          FROM bill_payment_tags t
          WHERE t.transaction_id IN (SELECT id FROM bank_transactions);

          DELETE FROM bill_payment_tags
          WHERE transaction_id IN (SELECT id FROM bank_transactions);
        `);

        // Step 3 — remove BANK rows from `transactions`.
        db.exec(`
          DELETE FROM transactions
          WHERE account_id IN (SELECT id FROM accounts WHERE type = 'BANK')
            AND COALESCE(source, 'pluggy') = 'pluggy';
        `);

        // Step 4 — dedupe by provider_transaction_id. Pluggy enriching a
        // description between syncs previously caused duplicate rows under
        // the same provider_id. Keep the most recently seen row; migrate
        // user work from the stale rows; delete them.
        const dupGroups = db
          .prepare(
            `SELECT provider_transaction_id, id, last_seen_at
             FROM bank_transactions
             WHERE provider_transaction_id IS NOT NULL
               AND provider_transaction_id IN (
                 SELECT provider_transaction_id FROM bank_transactions
                 WHERE provider_transaction_id IS NOT NULL
                 GROUP BY provider_transaction_id
                 HAVING COUNT(*) > 1
               )
             ORDER BY provider_transaction_id, last_seen_at DESC, first_seen_at DESC`,
          )
          .all() as Array<{ provider_transaction_id: string; id: string; last_seen_at: string }>;

        const grouped = new Map<string, string[]>();
        for (const r of dupGroups) {
          const arr = grouped.get(r.provider_transaction_id) ?? [];
          arr.push(r.id);
          grouped.set(r.provider_transaction_id, arr);
        }

        const migrateDescOv = db.prepare(
          'UPDATE OR IGNORE bank_transaction_description_overrides SET transaction_id = ? WHERE transaction_id = ?',
        );
        const migrateBillTag = db.prepare(
          'UPDATE OR IGNORE bank_bill_payment_tags SET transaction_id = ? WHERE transaction_id = ?',
        );
        const deleteRow = db.prepare('DELETE FROM bank_transactions WHERE id = ?');

        let removed = 0;
        for (const [, ids] of grouped) {
          const [keep, ...stale] = ids;
          for (const s of stale) {
            migrateDescOv.run(keep, s);
            migrateBillTag.run(keep, s);
            deleteRow.run(s);
            removed++;
          }
        }
        if (removed > 0) {
          console.log(`[migration] bank_transactions dedupe removed ${removed} stale duplicate row(s).`);
        }
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}

}

function addColumnIfMissing(db: Db, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
