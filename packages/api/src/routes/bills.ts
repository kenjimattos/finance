import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  computeBillWindowAtOffset,
  type BillWindow,
} from '../services/billWindow.js';

export const billsRouter = Router();

interface AccountSettingsRow {
  account_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
}

interface CardSettingsRow {
  item_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
}

interface SumRow {
  total: number | null;
}

/**
 * Scope filter for SQL queries — either by account_id (phase 2) or item_id (legacy).
 * All SQL helpers use this to pick the right WHERE clause.
 */
type Scope =
  | { kind: 'account'; accountId: string }
  | { kind: 'item'; itemId: string };

function scopeClause(s: Scope): { column: string; value: string } {
  return s.kind === 'account'
    ? { column: 't.account_id', value: s.accountId }
    : { column: 't.item_id', value: s.itemId };
}

function requireAccountSettings(accountId: string): AccountSettingsRow | null {
  return (
    (db
      .prepare('SELECT * FROM account_settings WHERE account_id = ?')
      .get(accountId) as AccountSettingsRow | undefined) ?? null
  );
}

function requireCardSettings(itemId: string): CardSettingsRow | null {
  return (
    (db
      .prepare('SELECT * FROM card_settings WHERE item_id = ?')
      .get(itemId) as CardSettingsRow | undefined) ?? null
  );
}

// GET /bills?itemId=... — list CLOSED bills cached from Pluggy
billsRouter.get('/bills', (req, res, next) => {
  try {
    const { itemId } = z.object({ itemId: z.string().min(1) }).parse(req.query);
    const rows = db
      .prepare(
        `SELECT id, account_id, item_id, due_date, total_amount,
                currency_code, minimum_payment, synced_at
         FROM bills
         WHERE item_id = ?
         ORDER BY due_date DESC`,
      )
      .all(itemId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bills/current/breakdown?itemId=...&offset=N
 *
 * Returns everything the dashboard needs to render the bill headline and
 * inbox in a single round trip:
 *   - the bill window dates (closing/due) for the requested cycle and
 *     adjacent cycles (for shift-aware transaction lookups)
 *   - overall total, previousTotal, delta
 *   - sorted category breakdown for the window
 *   - list of installment transactions landing in the window
 *
 * `offset` selects which cycle relative to the currently open bill:
 *   - 0  (default) = currently open bill
 *   - -1 = the bill that just closed
 *   - -N = N cycles in the past
 * The "previous" delta is always vs (offset - 1), so navigation back through
 * history keeps the same "vs prior month" framing.
 */
billsRouter.get('/bills/current/breakdown', (req, res, next) => {
  try {
    const { itemId, accountId, offset } = z
      .object({
        itemId: z.string().min(1),
        accountId: z.string().min(1).optional(),
        offset: z.coerce.number().int().default(0),
      })
      .parse(req.query);

    // Determine scope and settings: prefer account-level, fall back to item-level.
    let scope: Scope;
    let displayName: string | null;
    let closingDay: number;
    let dueDay: number;

    if (accountId) {
      const as = requireAccountSettings(accountId);
      if (!as) {
        res.status(412).json({
          error: 'AccountSettingsMissing',
          message:
            'Configure closing_day and due_day for this account via PUT /account-settings/:accountId before querying the open bill.',
        });
        return;
      }
      scope = { kind: 'account', accountId };
      displayName = as.display_name;
      closingDay = as.closing_day;
      dueDay = as.due_day;
    } else {
      const cs = requireCardSettings(itemId);
      if (!cs) {
        res.status(412).json({
          error: 'CardSettingsMissing',
          message:
            'Configure closing_day and due_day for this card via PUT /card-settings/:itemId before querying the open bill.',
        });
        return;
      }
      scope = { kind: 'item', itemId };
      displayName = cs.display_name;
      closingDay = cs.closing_day;
      dueDay = cs.due_day;
    }

    const settingsT = { closingDay, dueDay };
    const current = computeBillWindowAtOffset(settingsT, offset);
    const previous = computeBillWindowAtOffset(settingsT, offset - 1);
    const next = computeBillWindowAtOffset(settingsT, offset + 1);
    // prevPrev is needed so the previous window's total can also be shift-aware.
    const prevPrev = computeBillWindowAtOffset(settingsT, offset - 2);
    // nextNext lets us ask "does the NEXT bill have any transactions?"
    // using the same three-window shift-aware pattern.
    const nextNext = computeBillWindowAtOffset(settingsT, offset + 2);

    const total = round2(sumBillTotalWithShifts(scope, current, previous, next));
    const previousTotal = round2(
      sumBillTotalWithShifts(scope, previous, prevPrev, current),
    );
    const categories = categoryBreakdownWithShifts(scope, current, previous, next);
    const installments = installmentBreakdownWithShifts(
      scope,
      current,
      previous,
      next,
    );
    const hasNextBillTransactions = countTransactionsWithShifts(
      scope,
      next,
      current,
      nextNext,
    ) > 0;

    res.json({
      itemId,
      accountId: accountId ?? null,
      displayName,
      offset,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      closingDate: current.nextClosingDate,
      dueDate: current.nextDueDate,
      previousPeriodStart: previous.periodStart,
      previousPeriodEnd: previous.periodEnd,
      nextPeriodStart: next.periodStart,
      nextPeriodEnd: next.periodEnd,
      total,
      previousTotal,
      delta: round2(total - previousTotal),
      categories,
      installments,
      hasNextBillTransactions,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sum categorized spend in a bill window, honoring manual bill-shift
 * overrides. The caller passes three adjacent windows
 * (previous / current / next) and we include, in the CURRENT window's sum:
 *
 *   - transactions whose raw date falls in `current` AND have no override
 *   - transactions whose raw date falls in `previous` AND have an
 *     override shift = +1 (pushed forward into current)
 *   - transactions whose raw date falls in `next` AND have an override
 *     shift = -1 (pulled back into current)
 *
 * Double-shifted transactions (|shift| >= 2) are intentionally NOT handled
 * — they'd require chasing windows two cycles away, and the UI only
 * exposes ±1 anyway.
 */
function sumBillTotalWithShifts(
  scope: Scope,
  current: BillWindow,
  previous: BillWindow,
  next: BillWindow,
): number {
  const { column, value } = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(t.amount_in_account_currency, t.amount)), 0) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )`,
    )
    .get(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as SumRow;
  return row.total ?? 0;
}

/**
 * List the installment ("parcelada") transactions that land in the current
 * bill window, honoring bill-shift overrides. Installments are not filtered
 * by user categorization — they surface even if the user hasn't categorized
 * them yet, because the point of showing them is to remind the user of
 * pre-committed spending regardless of whether it's been classified.
 *
 * Sorted by date descending so the eye scans newest-first, matching the
 * transaction inbox convention.
 */
function installmentBreakdownWithShifts(
  scope: Scope,
  current: BillWindow,
  previous: BillWindow,
  next: BillWindow,
): Array<{
  id: string;
  date: string;
  description: string | null;
  amount: number;
  installmentNumber: number;
  totalInstallments: number;
}> {
  const { column, value } = scopeClause(scope);
  const rows = db
    .prepare(
      `SELECT t.id                  AS id,
              t.date                AS date,
              t.description         AS description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              t.installment_number  AS installmentNumber,
              t.total_installments  AS totalInstallments
       FROM transactions t
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND t.installment_number IS NOT NULL
         AND t.total_installments IS NOT NULL
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
       ORDER BY t.date DESC, t.id DESC`,
    )
    .all(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as Array<{
    id: string;
    date: string;
    description: string | null;
    amount: number;
    installmentNumber: number;
    totalInstallments: number;
  }>;
  return rows.map((r) => ({ ...r, amount: round2(r.amount) }));
}

/**
 * Variant of categoryBreakdown that honors manual bill-shift overrides.
 * Same windowing logic as sumBillTotalWithShifts.
 */
function categoryBreakdownWithShifts(
  scope: Scope,
  current: BillWindow,
  previous: BillWindow,
  next: BillWindow,
): Array<{ id: number; name: string; color: string; total: number }> {
  const { column, value } = scopeClause(scope);
  const rows = db
    .prepare(
      `SELECT uc.id        AS id,
              uc.name      AS name,
              uc.color     AS color,
              SUM(COALESCE(t.amount_in_account_currency, t.amount)) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       INNER JOIN user_categories uc        ON uc.id = tc.user_category_id
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
       GROUP BY uc.id
       ORDER BY total DESC`,
    )
    .all(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as Array<{ id: number; name: string; color: string; total: number }>;
  return rows.map((r) => ({ ...r, total: round2(r.total) }));
}


/**
 * Shift-aware count of ANY transactions (categorized or not, pluggy or manual)
 * that land in a given window. Used to decide whether the "next bill" arrow
 * should be enabled: if the window has zero lançamentos there is nothing to
 * navigate to.
 */
function countTransactionsWithShifts(
  scope: Scope,
  current: BillWindow,
  previous: BillWindow,
  next: BillWindow,
): number {
  const { column, value } = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM transactions t
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )`,
    )
    .get(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as SumRow;
  return row.total ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
