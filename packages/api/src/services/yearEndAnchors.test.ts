import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database, { type Database as DB } from 'better-sqlite3';
import { ensureYearEndAnchors } from './yearEndAnchors.js';

/**
 * Tests for ensureYearEndAnchors — the year-end roll-forward that runs at the
 * end of a bank sync. It freezes a `YYYY-12-31` anchor for every completed,
 * settled year by walking the latest trusted anchor forward through the year's
 * transactions (derived value, never the live Pluggy balance).
 *
 * In-memory SQLite with the minimal schema the function touches.
 */

let db: DB;

function createSchema(d: DB): void {
  d.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
    );
    CREATE TABLE bank_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL
    );
    CREATE TABLE bank_transaction_hidden (
      transaction_id TEXT PRIMARY KEY
    );
    CREATE TABLE balance_anchors (
      account_id TEXT NOT NULL,
      anchor_date TEXT NOT NULL,
      balance REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, anchor_date)
    );
  `);
}

let txSeq = 0;
function addAccount(id: string): void {
  db.prepare("INSERT INTO accounts (id, type) VALUES (?, 'BANK')").run(id);
}
function addTx(accountId: string, date: string, amount: number): string {
  const id = `tx-${txSeq++}`;
  db.prepare(
    'INSERT INTO bank_transactions (id, account_id, date, amount) VALUES (?, ?, ?, ?)',
  ).run(id, accountId, date, amount);
  return id;
}
function addAnchor(
  accountId: string,
  date: string,
  balance: number,
  source = 'manual',
): void {
  db.prepare(
    'INSERT INTO balance_anchors (account_id, anchor_date, balance, source) VALUES (?, ?, ?, ?)',
  ).run(accountId, date, balance, source);
}
function anchors(accountId: string): Array<{ anchor_date: string; balance: number; source: string }> {
  return db
    .prepare(
      'SELECT anchor_date, balance, source FROM balance_anchors WHERE account_id = ? ORDER BY anchor_date ASC',
    )
    .all(accountId) as Array<{ anchor_date: string; balance: number; source: string }>;
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('ensureYearEndAnchors', () => {
  it('rolls the base anchor forward into a settled year-end anchor', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);
    addTx('a', '2026-03-01', 50); // +50
    addTx('a', '2026-08-01', -20); // -20  → 2026 net +30
    addTx('a', '2027-02-01', 5); // realized into 2027 → 2026 is settled

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 1);
    assert.deepEqual(anchors('a'), [
      { anchor_date: '2025-12-31', balance: 100, source: 'manual' },
      { anchor_date: '2026-12-31', balance: 130, source: 'rollforward' },
    ]);
  });

  it('does not freeze a year that is not yet settled (within the buffer)', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);
    addTx('a', '2026-12-30', 50);
    addTx('a', '2027-01-10', 5); // before 2027-01-15 → 2026 not settled yet

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 0);
    assert.deepEqual(anchors('a'), [
      { anchor_date: '2025-12-31', balance: 100, source: 'manual' },
    ]);
  });

  it('chains across multiple settled years', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 0);
    addTx('a', '2026-06-01', 100); // 2026 net +100 → anchor 100
    addTx('a', '2027-06-01', 40); // 2027 net +40  → anchor 140
    addTx('a', '2028-02-01', 1); // realized into 2028 → 2026 & 2027 settled

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 2);
    assert.deepEqual(anchors('a'), [
      { anchor_date: '2025-12-31', balance: 0, source: 'manual' },
      { anchor_date: '2026-12-31', balance: 100, source: 'rollforward' },
      { anchor_date: '2027-12-31', balance: 140, source: 'rollforward' },
    ]);
  });

  it('excludes hidden transactions from the roll-forward sum', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);
    addTx('a', '2026-03-01', 50);
    const hidden = addTx('a', '2026-04-01', 999);
    db.prepare('INSERT INTO bank_transaction_hidden (transaction_id) VALUES (?)').run(hidden);
    addTx('a', '2027-02-01', 0);

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 1);
    assert.equal(anchors('a')[1].balance, 150); // 100 + 50, hidden 999 ignored
  });

  it('does not clobber a pre-existing year-end anchor and chains off it', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);
    addAnchor('a', '2026-12-31', 200, 'manual'); // user re-grounded
    addTx('a', '2026-05-01', 999); // would imply a different rollforward value
    addTx('a', '2027-06-01', 25); // 2027 net +25 → off the manual 200 → 225
    addTx('a', '2028-02-01', 0); // 2026 & 2027 settled

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 1); // only 2027 created; 2026 left as the manual row
    assert.deepEqual(anchors('a'), [
      { anchor_date: '2025-12-31', balance: 100, source: 'manual' },
      { anchor_date: '2026-12-31', balance: 200, source: 'manual' },
      { anchor_date: '2027-12-31', balance: 225, source: 'rollforward' },
    ]);
  });

  it('skips accounts with no base anchor', () => {
    addAccount('a');
    addTx('a', '2026-06-01', 100);
    addTx('a', '2027-02-01', 5);

    const created = ensureYearEndAnchors(db);

    assert.equal(created, 0);
    assert.deepEqual(anchors('a'), []);
  });

  it('is idempotent — a second run creates nothing', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);
    addTx('a', '2026-03-01', 50);
    addTx('a', '2027-02-01', 0);

    assert.equal(ensureYearEndAnchors(db), 1);
    assert.equal(ensureYearEndAnchors(db), 0);
  });

  it('is a no-op when there are no bank transactions', () => {
    addAccount('a');
    addAnchor('a', '2025-12-31', 100);

    assert.equal(ensureYearEndAnchors(db), 0);
  });
});
