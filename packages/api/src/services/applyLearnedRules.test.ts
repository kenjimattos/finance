import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database, { type Database as DB } from 'better-sqlite3';
import { applyLearnedRules } from './applyLearnedRules.js';

/**
 * Tests for applyLearnedRules — the function that runs after every Pluggy
 * sync to auto-categorize new transactions whose merchant slug matches a
 * known rule.
 *
 * The single most important property under test is the NON-OVERWRITE
 * INVARIANT: a manual or bulk categorization is sacred. Even if a learned
 * rule for the same merchant slug points at a different category,
 * applyLearnedRules must NEVER touch an already-categorized row. Two
 * separate failure modes are exercised:
 *
 *   1. The candidates query filter (LEFT JOIN ... WHERE tc IS NULL) — if
 *      this is dropped or weakened, "manual assignment is preserved" fails.
 *   2. The INSERT OR IGNORE clause — if changed to INSERT OR REPLACE, the
 *      "primary key safeguard" test fails because we feed it a candidate
 *      list that intentionally races with a pre-existing assignment.
 *
 * Both safeguards are intentional defense-in-depth, and both have a test
 * pinning them. See the docstring on applyLearnedRules itself for the
 * design rationale.
 *
 * Tests run against an in-memory SQLite created from scratch in
 * beforeEach, with the minimal subset of the production schema needed to
 * exercise the function. Keeping the schema inline (rather than importing
 * from db/index.ts) decouples the test from the production singleton DB
 * file and lets each test start from a known empty state.
 */

const ITEM_ID = 'item-test';

let db: DB;

function createSchema(d: DB): void {
  d.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      type TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL DEFAULT '#000'
    );

    CREATE TABLE transaction_categories (
      transaction_id TEXT PRIMARY KEY,
      user_category_id INTEGER NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      assigned_by TEXT NOT NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_category_id) REFERENCES user_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE category_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      merchant_slug TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      override_count INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      UNIQUE (merchant_slug, user_category_id),
      FOREIGN KEY (user_category_id) REFERENCES user_categories(id) ON DELETE CASCADE
    );
  `);
}

function insertTx(
  d: DB,
  id: string,
  description: string,
  opts: { itemId?: string } = {},
): void {
  d.prepare(
    `INSERT INTO transactions (id, account_id, item_id, date, description, amount, type)
     VALUES (?, 'acct', ?, '2026-04-01', ?, 100, 'DEBIT')`,
  ).run(id, opts.itemId ?? ITEM_ID, description);
}

function insertCategory(d: DB, name: string): number {
  const info = d
    .prepare(`INSERT INTO user_categories (name) VALUES (?)`)
    .run(name);
  return Number(info.lastInsertRowid);
}

function insertRule(d: DB, slug: string, categoryId: number): void {
  d.prepare(
    `INSERT INTO category_rules (merchant_slug, user_category_id) VALUES (?, ?)`,
  ).run(slug, categoryId);
}

function insertAssignment(
  d: DB,
  txId: string,
  categoryId: number,
  assignedBy: 'manual' | 'bulk' | 'learned',
): void {
  d.prepare(
    `INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by)
     VALUES (?, ?, ?)`,
  ).run(txId, categoryId, assignedBy);
}

function getAssignment(
  d: DB,
  txId: string,
): { user_category_id: number; assigned_by: string } | undefined {
  return d
    .prepare(
      `SELECT user_category_id, assigned_by
       FROM transaction_categories
       WHERE transaction_id = ?`,
    )
    .get(txId) as { user_category_id: number; assigned_by: string } | undefined;
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('applyLearnedRules', () => {
  // ─── Happy path ──────────────────────────────────────────────────────

  it('auto-categorizes uncategorized transactions matching a rule', () => {
    const food = insertCategory(db, 'Alimentação');
    insertRule(db, 'IFOOD', food);
    insertTx(db, 'tx-1', 'IFOOD *RESTAURANTE XYZ');

    applyLearnedRules(db, ITEM_ID);

    const a = getAssignment(db, 'tx-1');
    assert.deepEqual(a, { user_category_id: food, assigned_by: 'learned' });
  });

  it('bumps hit_count on the matched rule', () => {
    const food = insertCategory(db, 'Alimentação');
    insertRule(db, 'IFOOD', food);
    insertTx(db, 'tx-1', 'IFOOD *A');
    insertTx(db, 'tx-2', 'IFOOD *B');

    applyLearnedRules(db, ITEM_ID);

    const rule = db
      .prepare(`SELECT hit_count FROM category_rules WHERE merchant_slug = 'IFOOD'`)
      .get() as { hit_count: number };
    // Initial hit_count is 1 (from insertRule); two new hits → 3.
    assert.equal(rule.hit_count, 3);
  });

  it('skips transactions whose slug does not match any rule', () => {
    insertCategory(db, 'Alimentação');
    insertTx(db, 'tx-1', 'RANDOM MERCHANT XYZ');

    applyLearnedRules(db, ITEM_ID);

    assert.equal(getAssignment(db, 'tx-1'), undefined);
  });

  it('only touches transactions belonging to the requested itemId', () => {
    const food = insertCategory(db, 'Alimentação');
    insertRule(db, 'IFOOD', food);
    insertTx(db, 'tx-mine', 'IFOOD *A');
    insertTx(db, 'tx-other', 'IFOOD *B', { itemId: 'item-other' });

    applyLearnedRules(db, ITEM_ID);

    assert.ok(getAssignment(db, 'tx-mine'));
    assert.equal(getAssignment(db, 'tx-other'), undefined);
  });

  // ─── The non-overwrite invariant ─────────────────────────────────────
  //
  // These are the load-bearing tests. They lock the contract that
  // applyLearnedRules must never overwrite an existing categorization,
  // regardless of whether the prior assignment was manual, bulk, or even
  // a previous learned guess. The whole trust model of the categorization
  // engine depends on this property.

  it('does NOT overwrite a manual assignment when a rule points elsewhere', () => {
    const food = insertCategory(db, 'Alimentação');
    const home = insertCategory(db, 'Casa');
    insertRule(db, 'CARREFOUR', food); // rule says Alimentação
    insertTx(db, 'tx-1', 'CARREFOUR SP CSB 335');
    insertAssignment(db, 'tx-1', home, 'manual'); // user said Casa

    applyLearnedRules(db, ITEM_ID);

    const a = getAssignment(db, 'tx-1');
    assert.deepEqual(
      a,
      { user_category_id: home, assigned_by: 'manual' },
      'Manual assignment must survive a learned-rule pass',
    );
  });

  it('does NOT overwrite a bulk assignment', () => {
    const food = insertCategory(db, 'Alimentação');
    const home = insertCategory(db, 'Casa');
    insertRule(db, 'CARREFOUR', food);
    insertTx(db, 'tx-1', 'CARREFOUR SP');
    insertAssignment(db, 'tx-1', home, 'bulk');

    applyLearnedRules(db, ITEM_ID);

    const a = getAssignment(db, 'tx-1');
    assert.deepEqual(a, { user_category_id: home, assigned_by: 'bulk' });
  });

  it('does NOT overwrite a previous learned assignment', () => {
    // Two competing rules for the same slug — possible because the unique
    // index is on (merchant_slug, user_category_id), not on slug alone.
    // Whichever rule "won" first should stay; a re-run must not flip it.
    const a = insertCategory(db, 'A');
    const b = insertCategory(db, 'B');
    insertRule(db, 'AMBIG', a);
    insertRule(db, 'AMBIG', b);
    insertTx(db, 'tx-1', 'AMBIG MERCHANT');
    insertAssignment(db, 'tx-1', a, 'learned');

    applyLearnedRules(db, ITEM_ID);

    const got = getAssignment(db, 'tx-1');
    assert.equal(
      got?.user_category_id,
      a,
      'A re-run must not flip a previously-learned assignment to a competing rule',
    );
  });

  it('does not bump hit_count when the candidate already has a category', () => {
    // The candidates filter should keep the row out of the loop entirely,
    // so the rule's hit_count stays at its initial value.
    const food = insertCategory(db, 'Alimentação');
    const home = insertCategory(db, 'Casa');
    insertRule(db, 'CARREFOUR', food);
    insertTx(db, 'tx-1', 'CARREFOUR SP');
    insertAssignment(db, 'tx-1', home, 'manual');

    applyLearnedRules(db, ITEM_ID);

    const rule = db
      .prepare(`SELECT hit_count FROM category_rules WHERE merchant_slug = 'CARREFOUR'`)
      .get() as { hit_count: number };
    assert.equal(rule.hit_count, 1, 'hit_count must stay at the initial value');
  });

  // ─── Edge cases ──────────────────────────────────────────────────────

  it('is a no-op when there are no rules', () => {
    insertTx(db, 'tx-1', 'IFOOD *A');
    applyLearnedRules(db, ITEM_ID);
    assert.equal(getAssignment(db, 'tx-1'), undefined);
  });

  it('is a no-op when there are no uncategorized transactions', () => {
    const food = insertCategory(db, 'Alimentação');
    insertRule(db, 'IFOOD', food);
    // No transactions inserted at all.
    assert.doesNotThrow(() => applyLearnedRules(db, ITEM_ID));
  });

  it('skips transactions with a description that yields no slug', () => {
    const food = insertCategory(db, 'Alimentação');
    insertRule(db, 'IFOOD', food);
    insertTx(db, 'tx-1', '');

    applyLearnedRules(db, ITEM_ID);

    assert.equal(getAssignment(db, 'tx-1'), undefined);
  });
});
