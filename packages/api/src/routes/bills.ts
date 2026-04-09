import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { computeOpenBillWindow, computePreviousBillWindow } from '../services/billWindow.js';
import { parseCardGroupFilter } from './transactions.js';

export const billsRouter = Router();

interface CardSettingsRow {
  item_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
}

interface SumRow {
  total: number | null;
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
    const { itemId } = z.object({ itemId: z.string().min(1) }).parse(req.query);

    const settings = requireCardSettings(itemId);
    if (!settings) {
      res.status(412).json({
        error: 'CardSettingsMissing',
        message:
          'Configure closing_day and due_day for this card via PUT /card-settings/:itemId before querying the open bill.',
      });
      return;
    }

    const current = computeOpenBillWindow({
      closingDay: settings.closing_day,
      dueDay: settings.due_day,
    });
    const previous = computePreviousBillWindow({
      closingDay: settings.closing_day,
      dueDay: settings.due_day,
    });

    // Groups defined for this item. We iterate them (plus an "all" slot at
    // the front) and build a card per group with total, delta, and a sorted
    // list of category breakdowns. Tiny loop — user will have ≤3 groups in
    // practice, so there's no need for a single complex CTE query.
    const groups = db
      .prepare(
        `SELECT id, name, color FROM card_groups WHERE item_id = ? ORDER BY name ASC`,
      )
      .all(itemId) as Array<{ id: number; name: string; color: string }>;

    const allFilter = parseCardGroupFilter(undefined); // "any"

    const breakdown = [
      {
        groupId: null as number | null,
        name: 'Todos',
        color: null as string | null,
        total: round2(
          sumBillTotal(itemId, current.periodStart, current.periodEnd, allFilter),
        ),
        previousTotal: round2(
          sumBillTotal(itemId, previous.periodStart, previous.periodEnd, allFilter),
        ),
        categories: categoryBreakdown(
          itemId,
          current.periodStart,
          current.periodEnd,
          allFilter,
        ),
      },
    ];

    for (const g of groups) {
      const filter = parseCardGroupFilter(String(g.id));
      const total = sumBillTotal(itemId, current.periodStart, current.periodEnd, filter);
      const previousTotal = sumBillTotal(
        itemId,
        previous.periodStart,
        previous.periodEnd,
        filter,
      );
      const categories = categoryBreakdown(
        itemId,
        current.periodStart,
        current.periodEnd,
        filter,
      );

      // Skip groups with no categorized spending this cycle — an empty card
      // is worse than a missing one. "Todos" is never skipped because it
      // represents the whole bill and the user expects to see it.
      if (total === 0 && categories.length === 0) continue;

      breakdown.push({
        groupId: g.id,
        name: g.name,
        color: g.color,
        total: round2(total),
        previousTotal: round2(previousTotal),
        categories,
      });
    }

    res.json({
      itemId,
      displayName: settings.display_name,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      closingDate: current.nextClosingDate,
      dueDate: current.nextDueDate,
      groups: breakdown.map((b) => ({
        groupId: b.groupId,
        name: b.name,
        color: b.color,
        total: b.total,
        previousTotal: b.previousTotal,
        delta: round2(b.total - b.previousTotal),
        categories: b.categories,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sum each category's absolute spend in a bill window, optionally filtered
 * by card group. Returns rows sorted by total descending so the frontend
 * doesn't need to sort again. Only categorized transactions are included
 * (same rule as sumBillTotal).
 */
function categoryBreakdown(
  itemId: string,
  periodStart: string,
  periodEnd: string,
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): Array<{ id: number; name: string; color: string; total: number }> {
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
       WHERE t.item_id = ?
         AND t.date >= ?
         AND t.date <= ?
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )
       GROUP BY uc.id
       ORDER BY total DESC`,
    )
    .all(
      itemId,
      periodStart,
      periodEnd,
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
  itemId: string,
  periodStart: string,
  periodEnd: string,
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN card_group_members m
         ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
       WHERE t.item_id = ?
         AND t.date >= ?
         AND t.date <= ?
         AND (
           ? = 'any'
           OR (? = 'none' AND m.card_group_id IS NULL)
           OR (? = 'id'   AND m.card_group_id = ?)
         )`,
    )
    .get(
      itemId,
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
