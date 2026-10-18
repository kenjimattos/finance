import type { Database } from 'better-sqlite3';

/**
 * Today's date as `yyyy-mm-dd` in America/Sao_Paulo. Pluggy dates are
 * midnight BRT (stored as their UTC calendar day, which is the same day), so
 * "is this bank row in the future?" must be asked in BRT, not in the server's
 * UTC — otherwise rows dated tomorrow flip to realized at 21:00 local.
 */
export function todayInBrazil(now: Date = new Date()): string {
  // en-CA formats as yyyy-mm-dd.
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/**
 * The realized boundary of the cash-flow timeline: the latest date that has a
 * real BANK transaction, ignoring rows dated after `today`.
 *
 * Pluggy also serves *scheduled* checking-account rows (Itaú sends future PIX
 * installments as PENDING, dated months ahead). Those are not realized data —
 * if they counted, a single scheduled debit would push the boundary months
 * into the future, hiding manual entries and bill projections in between and
 * letting `pruneRealizedManualEntries` delete them. Scheduled rows belong to
 * projection territory instead.
 *
 * Still data-driven below `today`: if syncing stalls, the boundary stalls
 * with it rather than marking un-synced days as empty-but-realized.
 */
export function lastRealizedBankDate(
  db: Database,
  today: string = todayInBrazil(),
): string | null {
  const row = db
    .prepare('SELECT MAX(date) AS max_date FROM bank_transactions WHERE date <= ?')
    .get(today) as { max_date: string | null };
  return row.max_date;
}
