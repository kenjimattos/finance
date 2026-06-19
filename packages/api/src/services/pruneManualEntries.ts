import type { Database } from 'better-sqlite3';

/**
 * Drop `manual_entries` that real bank data has made obsolete.
 *
 * Manual entries are CashFlow projections for *future* days. The CashFlow
 * render already hides any entry whose date is at or before the realized
 * boundary (`MAX(bank_transactions.date)`), so once real bank data fully
 * covers a month, that month's entries are dead rows that only accumulate.
 *
 * Called at the end of a bank sync, this removes:
 *   - every entry from a month *strictly before* the last realized month, and
 *   - legacy rows with no `month` (never rendered, since the render filters
 *     `month = ?`).
 *
 * The boundary month itself is deliberately preserved: a mid-month projection
 * the bank has not yet reached should survive until its day passes. Pruning by
 * whole month (not by exact date) also sidesteps the day-clamp edge case
 * (`day_of_month = 31` in a 30-day month).
 *
 * No-op when there are no bank transactions at all — nothing is realized yet,
 * so nothing is obsolete.
 *
 * @returns the number of manual entries deleted.
 */
export function pruneRealizedManualEntries(db: Database): number {
  const realizedRow = db
    .prepare('SELECT MAX(date) AS max_date FROM bank_transactions')
    .get() as { max_date: string | null };

  if (!realizedRow.max_date) return 0;

  const realizedMonth = realizedRow.max_date.slice(0, 7); // YYYY-MM
  const result = db
    .prepare(
      `DELETE FROM manual_entries
       WHERE month IS NULL OR month < ?`,
    )
    .run(realizedMonth);

  return result.changes;
}
