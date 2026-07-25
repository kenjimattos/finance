import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database, { type Database as DB } from 'better-sqlite3';
import {
  upsertCreditTransactions,
  computeIdentityHash,
  lastFourDigits,
  toYmd,
  type IncomingCreditTransaction,
} from './syncCreditTransactions.js';

/**
 * Tests for the credit-card transaction upsert engine — every branch of the
 * sync state machine (docs/sync.md), exercised against an in-memory SQLite.
 *
 * Several fixtures are REAL payloads from the 2026-07 PicPay incident
 * (transaction_sync_conflicts rows 50–57 in production), where Pluggy
 * mutated stale PENDING records in place across two daily scrapes:
 * stage 1 rewrote description/date keeping the old amount ("chimera"),
 * stage 2 then fixed the amount to the real purchase. The engine decisions
 * around those payloads are what this suite locks down.
 */

const ITEM_ID = 'item-test';
const ACCOUNT_ID = 'acct-test';

let db: DB;

function createSchema(d: DB): void {
  d.exec(`
    CREATE TABLE transactions (
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
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE transaction_bill_overrides (
      transaction_id TEXT PRIMARY KEY,
      shift INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE transaction_splits (
      transaction_id TEXT PRIMARY KEY,
      split_type TEXT NOT NULL CHECK(split_type IN ('half', 'theirs')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE transaction_sync_conflicts (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_transaction_id TEXT NOT NULL,
      kept_transaction_id     TEXT NOT NULL,
      new_transaction_id      TEXT NOT NULL,
      old_payload_json        TEXT NOT NULL,
      new_payload_json        TEXT NOT NULL,
      detected_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE account_settings (
      account_id   TEXT PRIMARY KEY,
      display_name TEXT,
      closing_day  INTEGER NOT NULL,
      due_day      INTEGER NOT NULL
    );
  `);
}

// ── Fixture payloads ──────────────────────────────────────────────────────

/** Build a payload with sensible defaults, overridable per test. */
function payload(over: Partial<IncomingCreditTransaction> & { id: string }): IncomingCreditTransaction {
  return {
    description: 'MERCHANT GENERICO        .SAO PAULO  BRA',
    descriptionRaw: over.description ?? 'MERCHANT GENERICO        .SAO PAULO  BRA',
    amount: 50,
    currencyCode: 'BRL',
    date: '2026-07-10T12:00:00.001Z',
    type: 'DEBIT',
    status: 'PENDING',
    creditCardMetadata: { cardNumber: '3047' },
    ...over,
  };
}

/** Real prod payload: the stale Claro pending (conflict 53, old side). */
const CLARO = payload({
  id: '38c67b97-ab11-420c-9993-e13e7ea37016',
  description: 'CLARO P*Fatura Claro     .BELEM      PA',
  descriptionRaw: 'CLARO P*Fatura Claro     .BELEM      PA',
  amount: 101.14,
  date: '2026-04-22T15:41:22.001Z',
});

function run(txs: IncomingCreditTransaction[]) {
  return upsertCreditTransactions(db, txs, ACCOUNT_ID, ITEM_ID);
}

function allRows() {
  return db
    .prepare(`SELECT * FROM transactions ORDER BY first_seen_at, id`)
    .all() as Array<Record<string, unknown>>;
}

function conflicts() {
  return db
    .prepare(`SELECT * FROM transaction_sync_conflicts ORDER BY id`)
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

describe('upsertCreditTransactions', () => {
  // ─── Outcome 4: brand-new transaction ────────────────────────────────

  it('inserts a brand-new transaction with a local UUID and identity hash', () => {
    const counts = run([CLARO]);

    assert.deepEqual(counts, { processed: 1, inserted: 1, updated: 0, reposts: 0, recycled: 0 });
    const rows = allRows();
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.notEqual(r.id, CLARO.id); // local UUID, not the Pluggy ID
    assert.equal(r.provider_transaction_id, CLARO.id);
    assert.equal(r.date, '2026-04-22');
    assert.equal(r.amount, 101.14);
    assert.equal(r.card_last4, '3047');
    assert.equal(
      r.identity_hash,
      computeIdentityHash('2026-04-22', 101.14, CLARO.description ?? null),
    );
  });

  // ─── Outcome 1: same provider ID, same content ───────────────────────

  it('updates mutable fields in place when content is unchanged; user work survives', () => {
    run([CLARO]);
    const [row] = allRows();

    // Simulate user work on the row.
    db.prepare(`INSERT INTO user_categories (name) VALUES ('Assinaturas')`).run();
    db.prepare(
      `INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by)
       VALUES (?, 1, 'manual')`,
    ).run(row.id);

    const counts = run([{ ...CLARO, status: 'POSTED' }]);

    assert.equal(counts.updated, 1);
    const rows = allRows();
    assert.equal(rows.length, 1); // no duplicate
    assert.equal(rows[0].id, row.id); // same local UUID
    assert.equal(rows[0].status, 'POSTED');
    const cat = db
      .prepare(`SELECT * FROM transaction_categories WHERE transaction_id = ?`)
      .get(row.id);
    assert.ok(cat, 'category assignment must survive the update');
  });

  it('treats a NULL stored identity hash as a match (pre-migration rows)', () => {
    run([CLARO]);
    const [row] = allRows();
    db.prepare(`UPDATE transactions SET identity_hash = NULL WHERE id = ?`).run(row.id);

    const counts = run([CLARO]);

    assert.equal(counts.updated, 1);
    assert.equal(allRows().length, 1);
    assert.ok(allRows()[0].identity_hash, 'hash is backfilled on update');
  });

  // ─── Outcome 2: repost (PENDING→POSTED date move) ────────────────────

  it('moves the date in place on a repost (same amount + slug, new date)', () => {
    run([CLARO]);
    const [row] = allRows();

    const counts = run([
      { ...CLARO, date: '2026-04-25T03:00:00.001Z', status: 'POSTED' },
    ]);

    assert.equal(counts.reposts, 1);
    const rows = allRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, row.id);
    assert.equal(rows[0].date, '2026-04-25');
    assert.equal(rows[0].status, 'POSTED');
  });

  it('clears a bill-shift override when the reposted date lands on the target bill naturally', () => {
    // Closing day 16: a pending row dated on the due date (25/05) belongs
    // naturally to the bill that closes 16/06; the user shifted it -1 to
    // show it on the bill closing 16/05. When it posts with a real date
    // inside that bill's window (e.g. 10/05), the shift must go.
    db.prepare(
      `INSERT INTO account_settings (account_id, closing_day, due_day) VALUES (?, 16, 25)`,
    ).run(ACCOUNT_ID);

    const pending = payload({
      id: 'itau-parcela-1',
      description: 'LOJA PARCELA 01/05',
      amount: 200,
      date: '2026-05-25T03:00:00.001Z',
    });
    run([pending]);
    const [row] = allRows();
    db.prepare(
      `INSERT INTO transaction_bill_overrides (transaction_id, shift) VALUES (?, -1)`,
    ).run(row.id);

    run([{ ...pending, date: '2026-05-10T03:00:00.001Z', status: 'POSTED' }]);

    const override = db
      .prepare(`SELECT shift FROM transaction_bill_overrides WHERE transaction_id = ?`)
      .get(row.id);
    assert.equal(override, undefined, 'stale shift must be removed');
    assert.equal(allRows()[0].date, '2026-05-10');
  });

  // ─── Outcome 3: recycled provider ID ─────────────────────────────────

  it('keeps the old row and mints a new one when the payload is a materially different purchase', () => {
    run([CLARO]);
    const [oldRow] = allRows();

    // A genuinely different purchase reusing the same Pluggy ID (different
    // amount + merchant + date — like the 23/07 prod batch).
    const recycled = payload({
      id: CLARO.id,
      description: 'CONSORCIO   *CNVW        .SAO PAULO  BRA',
      descriptionRaw: 'CONSORCIO   *CNVW        .SAO PAULO  BRA',
      amount: 1716.3,
      date: '2026-07-19T18:49:15.001Z',
    });
    const counts = run([recycled]);

    assert.equal(counts.recycled, 1);
    const rows = allRows();
    assert.equal(rows.length, 2);
    const kept = rows.find((r) => r.id === oldRow.id)!;
    const minted = rows.find((r) => r.id !== oldRow.id)!;
    assert.equal(kept.amount, 101.14); // old row untouched
    assert.equal(minted.amount, 1716.3);
    assert.equal(minted.provider_transaction_id, CLARO.id); // shared provider ID

    const cs = conflicts();
    assert.equal(cs.length, 1);
    assert.equal(cs[0].kept_transaction_id, oldRow.id);
    assert.equal(cs[0].new_transaction_id, minted.id);
  });

  it('subsequent syncs of the recycled payload match the minted row (no repeat conflicts)', () => {
    run([CLARO]);
    const recycled = payload({
      id: CLARO.id,
      description: 'CONSORCIO   *CNVW        .SAO PAULO  BRA',
      descriptionRaw: 'CONSORCIO   *CNVW        .SAO PAULO  BRA',
      amount: 1716.3,
      date: '2026-07-19T18:49:15.001Z',
    });
    run([recycled]);
    // In production the recycle happens months after the original row was
    // first seen, so findByProviderId's ORDER BY first_seen_at DESC finds the
    // minted row. In tests both rows land in the same second — make the
    // ordering explicit to match the real timeline.
    const mintedId = (conflicts()[0] as { new_transaction_id: string }).new_transaction_id;
    db.prepare(
      `UPDATE transactions SET first_seen_at = datetime('now', '+1 hour') WHERE id = ?`,
    ).run(mintedId);

    const counts = run([recycled]); // next sync, same payload

    assert.equal(counts.updated, 1);
    assert.equal(counts.recycled, 0);
    assert.equal(allRows().length, 2);
    assert.equal(conflicts().length, 1, 'no duplicate conflict rows');
  });

  // ─── Reconnect: unknown provider ID, known content ───────────────────

  it('adopts the new provider ID when an unknown ID carries known content (reconnect)', () => {
    run([CLARO]);
    const [row] = allRows();

    const counts = run([{ ...CLARO, id: 'new-provider-id-after-reconnect' }]);

    assert.equal(counts.updated, 1);
    assert.equal(counts.inserted, 0);
    const rows = allRows();
    assert.equal(rows.length, 1, 'no duplicate row');
    assert.equal(rows[0].id, row.id);
    assert.equal(rows[0].provider_transaction_id, 'new-provider-id-after-reconnect');
  });

  it('generation rotation (PicPay): the same purchase re-served under a fresh ID every scrape is deduped', () => {
    // Real prod pattern (probe of 2026-07-25): identical content down to the
    // millisecond timestamp, one copy per daily scrape, distinct UUIDs.
    const gen1 = payload({
      id: '673beff2-e0ac-4326-b98f-edf44ce733d7',
      description: 'CARREFOUR SP CSB 335     .SAO BERNAR BRA',
      descriptionRaw: 'CARREFOUR SP CSB 335     .SAO BERNAR BRA',
      amount: 17.73,
      date: '2026-07-13T17:06:14.001Z',
    });
    const gen2 = { ...gen1, id: '361b2aee-a37b-4f62-a4fd-ab230241a7d8' };

    run([gen1]);
    run([gen2]);

    const rows = allRows();
    assert.equal(rows.length, 1, 'generations collapse into one row');
    assert.equal(rows[0].provider_transaction_id, gen2.id);
  });
});

describe('helpers', () => {
  it('computeIdentityHash ignores account and is stable', () => {
    const a = computeIdentityHash('2026-07-13', 17.73, 'CARREFOUR SP CSB 335     .SAO BERNAR BRA');
    const b = computeIdentityHash('2026-07-13', 17.73, 'CARREFOUR SP CSB 335  .SAO BERNAR BRA');
    assert.equal(a, b, 'same slug → same hash despite whitespace noise');
    assert.notEqual(a, computeIdentityHash('2026-07-14', 17.73, 'CARREFOUR SP CSB 335'));
  });

  it('lastFourDigits handles the known cardNumber shapes', () => {
    assert.equal(lastFourDigits('3047'), '3047');
    assert.equal(lastFourDigits('****1234'), '1234');
    assert.equal(lastFourDigits('1234 **** **** 5678'), '5678');
    assert.equal(lastFourDigits('DIGITAL-PICPAY'), 'DIGITAL-PICPAY');
    assert.equal(lastFourDigits(''), null);
    assert.equal(lastFourDigits(null), null);
    assert.equal(lastFourDigits(undefined), null);
  });

  it('toYmd normalizes Dates and ISO strings to yyyy-mm-dd (UTC)', () => {
    assert.equal(toYmd('2026-07-13T17:06:14.001Z'), '2026-07-13');
    assert.equal(toYmd(new Date('2026-07-13T23:59:59.000Z')), '2026-07-13');
    assert.equal(toYmd('2026-07-13'), '2026-07-13');
  });
});
