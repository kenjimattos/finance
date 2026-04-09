import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  computeOpenBillWindow,
  computePreviousBillWindow,
  computeNextBillWindow,
  type BillWindow,
} from '../services/billWindow.js';
import { parseCardGroupFilter } from './transactions.js';

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

function groupScopeClause(s: Scope): { column: string; value: string } {
  return s.kind === 'account'
    ? { column: 'g.account_id', value: s.accountId }
    : { column: 'g.item_id', value: s.itemId };
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
 * GET /bills/current/breakdown?itemId=...
 *
 * Returns everything the dashboard needs to render the "cards per card group"
 * layout in a single round trip:
 *   - the current bill window dates (closing/due)
 *   - one entry for "all" (groupId: null) with overall total/delta/top categories
 *   - one entry per card group (only groups that actually have categorized
 *     transactions in the window — empty groups are skipped)
 *
 * Per the design decision, the "no group" bucket is NOT returned — the user
 * asked for it not to appear as a card.
 */
billsRouter.get('/bills/current/breakdown', (req, res, next) => {
  try {
    const { itemId, accountId } = z
      .object({
        itemId: z.string().min(1),
        accountId: z.string().min(1).optional(),
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
    const current = computeOpenBillWindow(settingsT);
    const previous = computePreviousBillWindow(settingsT);
    const next = computeNextBillWindow(settingsT);

    const { column: gCol, value: gVal } = groupScopeClause(scope);
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.color FROM card_groups g WHERE ${gCol} = ? ORDER BY g.name ASC`,
      )
      .all(gVal) as Array<{ id: number; name: string; color: string }>;

    const allFilter = parseCardGroupFilter(undefined); // "any"

    const breakdown = [
      {
        groupId: null as number | null,
        name: 'Todos',
        color: null as string | null,
        total: round2(
          sumBillTotalWithShifts(scope, current, previous, next, allFilter),
        ),
        previousTotal: round2(
          sumBillTotal(scope, previous.periodStart, previous.periodEnd, allFilter),
        ),
        categories: categoryBreakdownWithShifts(
          scope,
          current,
          previous,
          next,
          allFilter,
        ),
        installments: installmentBreakdownWithShifts(
          scope,
          current,
          previous,
          next,
          allFilter,
        ),
      },
    ];

    for (const g of groups) {
      const filter = parseCardGroupFilter(String(g.id));
      const total = sumBillTotalWithShifts(scope, current, previous, next, filter);
      const previousTotal = sumBillTotal(
        scope,
        previous.periodStart,
        previous.periodEnd,
        filter,
      );
      const categories = categoryBreakdownWithShifts(
        scope,
        current,
        previous,
        next,
        filter,
      );
      const installments = installmentBreakdownWithShifts(
        scope,
        current,
        previous,
        next,
        filter,
      );

      if (total === 0 && categories.length === 0) continue;

      breakdown.push({
        groupId: g.id,
        name: g.name,
        color: g.color,
        total: round2(total),
        previousTotal: round2(previousTotal),
        categories,
        installments,
      });
    }

    res.json({
      itemId,
      accountId: accountId ?? null,
      displayName,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      closingDate: current.nextClosingDate,
      dueDate: current.nextDueDate,
      previousPeriodStart: previous.periodStart,
      previousPeriodEnd: previous.periodEnd,
      nextPeriodStart: next.periodStart,
      nextPeriodEnd: next.periodEnd,
      groups: breakdown.map((b) => ({
        groupId: b.groupId,
        name: b.name,
        color: b.color,
        total: b.total,
        previousTotal: b.previousTotal,
        delta: round2(b.total - b.previousTotal),
        categories: b.categories,
        installments: b.installments,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Variant of sumBillTotal that honors manual bill-shift overrides. The
 * caller passes the three adjacent windows (previous / current / next)
 * and we include, in the CURRENT window's sum:
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
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): number {
  const { column, value } = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN card_group_members m
         ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )`,
    )
    .get(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind === 'id' ? groupFilter.id : null,
    ) as SumRow;
  return row.total ?? 0;
}

/**
 * List the installment ("parcelada") transactions that land in the current
 * bill window for the given card group filter, honoring bill-shift
 * overrides. Installments are not filtered by user categorization — they
 * surface even if the user hasn't categorized them yet, because the point
 * of showing them is to remind the user of pre-committed spending
 * regardless of whether it's been classified.
 *
 * Sorted by date descending so the eye scans newest-first, matching the
 * transaction inbox convention.
 */
function installmentBreakdownWithShifts(
  scope: Scope,
  current: BillWindow,
  previous: BillWindow,
  next: BillWindow,
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
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
              t.amount              AS amount,
              t.installment_number  AS installmentNumber,
              t.total_installments  AS totalInstallments
       FROM transactions t
       LEFT JOIN card_group_members m
         ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND t.installment_number IS NOT NULL
         AND t.total_installments IS NOT NULL
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )
       ORDER BY t.date DESC, t.id DESC`,
    )
    .all(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind === 'id' ? groupFilter.id : null,
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
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): Array<{ id: number; name: string; color: string; total: number }> {
  const { column, value } = scopeClause(scope);
  const rows = db
    .prepare(
      `SELECT uc.id        AS id,
              uc.name      AS name,
              uc.color     AS color,
              SUM(t.amount) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       INNER JOIN user_categories uc        ON uc.id = tc.user_category_id
       LEFT JOIN card_group_members m
         ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       WHERE ${column} = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )
       GROUP BY uc.id
       ORDER BY total DESC`,
    )
    .all(
      value,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind === 'id' ? groupFilter.id : null,
    ) as Array<{ id: number; name: string; color: string; total: number }>;
  return rows.map((r) => ({ ...r, total: round2(r.total) }));
}

/**
 * Sum the spend in a bill window, optionally filtered by card group.
 *
 * Sign convention in the Pluggy data we actually receive (verified against
 * Meu Pluggy): DEBIT transactions (purchases) come with a POSITIVE amount,
 * CREDIT transactions (refunds, reversals) come with a NEGATIVE amount.
 * This is the bank's own bookkeeping perspective: "amount you owe". So a
 * plain SUM() already gives "how much you owe net of reversals" without
 * any sign inversion.
 *
 * (The original code did `-SUM(amount)` based on the pluggy-sdk type
 *  documentation, which said "positive = CREDIT = inflow". That doc
 *  disagreed with the data actually returned for credit card accounts,
 *  leading to negative totals. Trust the data, not the docs — again.)
 *
 * Only CATEGORIZED transactions contribute to the total. This is
 * intentional: categorization is the user's way of saying "yes, this
 * belongs in my bill". Anything uncategorized (including noise like
 * "pagamento de fatura" or "pagamento recebido") stays out. No extra
 * schema, no ignore flag — the absence of a category IS the exclusion.
 */
function sumBillTotal(
  scope: Scope,
  periodStart: string,
  periodEnd: string,
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): number {
  const { column, value } = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN card_group_members m
         ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
       WHERE ${column} = ?
         AND t.date >= ?
         AND t.date <= ?
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )`,
    )
    .get(
      value,
      periodStart,
      periodEnd,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind,
      groupFilter.kind === 'id' ? groupFilter.id : null,
    ) as SumRow;
  return row.total ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
