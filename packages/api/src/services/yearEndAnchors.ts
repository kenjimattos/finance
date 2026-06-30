import type { Database } from 'better-sqlite3';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const NOT_HIDDEN_SQL =
  'NOT EXISTS (SELECT 1 FROM bank_transaction_hidden h WHERE h.transaction_id = t.id)';

/**
 * Freeze a year-end balance anchor for every completed, settled year.
 *
 * The CashFlow opening balance is grounded on the most recent `balance_anchors`
 * row (a trusted absolute balance) plus a walk over the transaction history.
 * Left alone, that walk grows without bound and — worse — would silently break
 * once Pluggy ages out old transactions: a year of charges that no longer exist
 * in `bank_transactions` can no longer be summed.
 *
 * To prevent that, at each year-end we roll the latest anchor FORWARD through
 * the year's transactions and store the result as a new `YYYY-12-31` anchor:
 *
 *   anchor(Y-12-31).balance = prevAnchor.balance
 *                           + Σ(not-hidden tx, prevAnchor.date < date <= Y-12-31)
 *
 * computed while those transactions still exist. The opening calculation then
 * anchors on this fresh row, so it never needs the now-aged-out rows. The value
 * is DERIVED from the existing trusted anchor (option B): it is NOT read from
 * the live/snapshot Pluggy balance, which oscillates and would reintroduce the
 * bug this whole mechanism exists to avoid. The roll-forward therefore carries
 * any drift forward unchanged — re-grounding against a real statement stays a
 * deliberate manual action (update/insert an anchor by hand).
 *
 * Settle buffer: a year `Y` is only frozen once the realized bank data has
 * moved past `Y+1-01-15`, so late-December transactions have posted before the
 * anchor bakes in the year's sum.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` never clobbers an existing anchor (e.g.
 * a manual re-grounding), and the chain advances off whatever anchor sits at
 * each year-end. Accounts with no base anchor are skipped — they fall back to
 * the live balance and have nothing to roll forward.
 *
 * @returns the number of year-end anchors created.
 */
export function ensureYearEndAnchors(db: Database): number {
  const lastRow = db
    .prepare('SELECT MAX(date) AS d FROM bank_transactions')
    .get() as { d: string | null };
  if (!lastRow.d) return 0;
  const lastRealized = lastRow.d;

  const accounts = db
    .prepare("SELECT id FROM accounts WHERE type = 'BANK'")
    .all() as Array<{ id: string }>;

  const latestAnchorStmt = db.prepare(
    `SELECT anchor_date, balance FROM balance_anchors
     WHERE account_id = ? ORDER BY anchor_date DESC LIMIT 1`,
  );
  const anchorAtStmt = db.prepare(
    `SELECT balance FROM balance_anchors WHERE account_id = ? AND anchor_date = ?`,
  );
  const sumBetweenStmt = db.prepare(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM bank_transactions t
     WHERE t.account_id = ? AND t.date > ? AND t.date <= ?
       AND ${NOT_HIDDEN_SQL}`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO balance_anchors (account_id, anchor_date, balance, source)
     VALUES (?, ?, ?, 'rollforward')
     ON CONFLICT(account_id, anchor_date) DO NOTHING`,
  );

  // Year Y is settled once realized data reaches Y+1-01-15.
  const settledThrough = (year: number): boolean =>
    `${year + 1}-01-15` <= lastRealized;

  let created = 0;
  const run = db.transaction(() => {
    for (const acct of accounts) {
      let anchor = latestAnchorStmt.get(acct.id) as
        | { anchor_date: string; balance: number }
        | undefined;
      if (!anchor) continue; // no trusted base — nothing to roll forward

      for (
        let year = Number(anchor.anchor_date.slice(0, 4)) + 1;
        settledThrough(year);
        year++
      ) {
        const target = `${year}-12-31`;
        const sum = (
          sumBetweenStmt.get(acct.id, anchor.anchor_date, target) as {
            total: number;
          }
        ).total;
        const balance = round2(anchor.balance + sum);

        const res = insertStmt.run(acct.id, target, balance);
        if (res.changes > 0) created++;

        // Advance the chain off whatever anchor now sits at this year-end
        // (the one we just inserted, or a pre-existing manual one we skipped).
        const existing = anchorAtStmt.get(acct.id, target) as
          | { balance: number }
          | undefined;
        anchor = { anchor_date: target, balance: existing?.balance ?? balance };
      }
    }
  });
  run();

  return created;
}
