import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database, { type Database as DB } from 'better-sqlite3';
import { pruneRealizedManualEntries } from './pruneManualEntries.js';

/**
 * Tests for pruneRealizedManualEntries — the cleanup that runs at the end of
 * a bank sync to drop CashFlow manual entries that real bank data has made
 * obsolete.
 *
 * The realized boundary is MAX(bank_transactions.date). Pruning is by whole
 * MONTH, conservatively:
 *   - months STRICTLY BEFORE the boundary month are removed,
 *   - the boundary month is PRESERVED (a mid-month projection the bank has
 *     not yet reached must survive),
 *   - legacy rows with no `month` are removed (the render never shows them),
 *   - and it is a no-op when no bank transactions exist.
 *
 * Tests run against an in-memory SQLite created in beforeEach with the
 * minimal schema the function touches, mirroring applyLearnedRules.test.ts.
 */

let db: DB;

function createSchema(d: DB): void {
  d.exec(`
    CREATE TABLE bank_transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL
    );

    CREATE TABLE manual_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      day_of_month INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      month TEXT,
      sort_key REAL
    );
  `);
}

let bankTxSeq = 0;
function addBankTx(date: string): void {
  db.prepare('INSERT INTO bank_transactions (id, date) VALUES (?, ?)').run(
    `bt-${bankTxSeq++}`,
    date,
  );
}

function addEntry(month: string | null, day = 15): number {
  const info = db
    .prepare(
      `INSERT INTO manual_entries (description, amount, day_of_month, month)
       VALUES ('x', -100, ?, ?)`,
    )
    .run(day, month);
  return Number(info.lastInsertRowid);
}

function remainingMonths(): Array<string | null> {
  return (
    db
      .prepare('SELECT month FROM manual_entries ORDER BY id ASC')
      .all() as Array<{ month: string | null }>
  ).map((r) => r.month);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('pruneRealizedManualEntries', () => {
  it('removes whole months strictly before the realized month', () => {
    addBankTx('2026-05-20'); // boundary month = 2026-05
    addEntry('2026-03');
    addEntry('2026-04');
    addEntry('2026-05'); // boundary month — kept
    addEntry('2026-06'); // future — kept

    const deleted = pruneRealizedManualEntries(db);

    assert.equal(deleted, 2);
    assert.deepEqual(remainingMonths(), ['2026-05', '2026-06']);
  });

  it('preserves the boundary month even when the bank has not reached the entry day', () => {
    // Bank realized through 2026-05-10, but the entry sits on 2026-05-25.
    addBankTx('2026-05-10');
    addEntry('2026-05', 25);

    const deleted = pruneRealizedManualEntries(db);

    assert.equal(deleted, 0);
    assert.deepEqual(remainingMonths(), ['2026-05']);
  });

  it('removes legacy rows with no month', () => {
    addBankTx('2026-05-20');
    addEntry(null);
    addEntry('2026-06'); // future — kept

    const deleted = pruneRealizedManualEntries(db);

    assert.equal(deleted, 1);
    assert.deepEqual(remainingMonths(), ['2026-06']);
  });

  it('is a no-op when there are no bank transactions', () => {
    addEntry(null);
    addEntry('2020-01');
    addEntry('2026-06');

    const deleted = pruneRealizedManualEntries(db);

    assert.equal(deleted, 0);
    assert.deepEqual(remainingMonths(), [null, '2020-01', '2026-06']);
  });

  it('uses the latest bank date as the boundary, not the earliest', () => {
    addBankTx('2026-01-15');
    addBankTx('2026-04-30'); // latest → boundary month = 2026-04
    addEntry('2026-03'); // before boundary — removed
    addEntry('2026-04'); // boundary month — kept

    const deleted = pruneRealizedManualEntries(db);

    assert.equal(deleted, 1);
    assert.deepEqual(remainingMonths(), ['2026-04']);
  });
});
