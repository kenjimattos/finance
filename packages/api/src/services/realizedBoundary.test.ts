import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database, { type Database as DB } from 'better-sqlite3';
import { lastRealizedBankDate, todayInBrazil } from './realizedBoundary.js';

/**
 * Tests for the cash-flow realized boundary: the latest BANK row dated on or
 * before today (BRT). Rows dated after today are scheduled (Itaú serves future
 * PIX installments as PENDING) and must not move the boundary.
 */

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE bank_transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL)');
});

let seq = 0;
function addBankTx(date: string): void {
  db.prepare('INSERT INTO bank_transactions (id, date) VALUES (?, ?)').run(`bt-${seq++}`, date);
}

describe('lastRealizedBankDate', () => {
  it('returns the latest row on or before today', () => {
    addBankTx('2026-10-01');
    addBankTx('2026-10-17');
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), '2026-10-17');
  });

  it('counts a row dated today as realized', () => {
    addBankTx('2026-10-18');
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), '2026-10-18');
  });

  it('ignores scheduled rows dated after today', () => {
    addBankTx('2026-10-17');
    addBankTx('2026-11-16');
    addBankTx('2026-12-16');
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), '2026-10-17');
  });

  it('stays data-driven: a stalled sync keeps the boundary behind today', () => {
    addBankTx('2026-09-28');
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), '2026-09-28');
  });

  it('returns null when nothing is realized yet', () => {
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), null);
    addBankTx('2026-12-16');
    assert.equal(lastRealizedBankDate(db, '2026-10-18'), null);
  });
});

describe('todayInBrazil', () => {
  it('uses the BRT calendar day, not UTC', () => {
    // 01:30 UTC on the 19th is still 22:30 on the 18th in São Paulo.
    assert.equal(todayInBrazil(new Date('2026-10-19T01:30:00Z')), '2026-10-18');
    assert.equal(todayInBrazil(new Date('2026-10-19T03:00:00Z')), '2026-10-19');
  });
});
