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

const currentQuerySchema = z.object({
  itemId: z.string().min(1),
  cardGroupId: z.string().optional(),
});

// GET /bills/current?itemId=...&cardGroupId=...
// Returns the *open* bill window (computed, not stored) plus its running total
// and a comparison against the previous bill window. This is the main summary
// card the frontend renders at the top of the screen.
//
// cardGroupId filter semantics:
//   omitted → all cards (full bill)
//   "none"  → cards with no group (unassigned)
//   "<id>"  → cards in that group
billsRouter.get('/bills/current', (req, res, next) => {
  try {
    const { itemId, cardGroupId } = currentQuerySchema.parse(req.query);
    const groupFilter = parseCardGroupFilter(cardGroupId);

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

    const currentTotal = sumBillTotal(itemId, current.periodStart, current.periodEnd, groupFilter);
    const previousTotal = sumBillTotal(itemId, previous.periodStart, previous.periodEnd, groupFilter);

    res.json({
      itemId,
      displayName: settings.display_name,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      closingDate: current.nextClosingDate,
      dueDate: current.nextDueDate,
      total: round2(currentTotal),
      previousTotal: round2(previousTotal),
      delta: round2(currentTotal - previousTotal),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sum the absolute spend in a bill window, optionally filtered by card group.
 * Returns a POSITIVE number representing "how much you owe" — amounts are
 * stored negative for purchases (Pluggy convention), so we invert via -SUM().
 *
 * Only CATEGORIZED transactions contribute to the total. This is intentional:
 * categorization is the user's way of saying "yes, this belongs in my bill".
 * Anything the user hasn't yet touched (including noise like "pagamento de
 * fatura" or "pagamento recebido") stays out of the number, and the user
 * just leaves those rows uncategorized to exclude them. No extra schema,
 * no ignore flag — the absence of a category IS the exclusion.
 *
 * Side effect to be aware of: the number starts at R$ 0 on a freshly synced
 * card and grows as the user categorizes. Delta-vs-previous is also
 * categorized-vs-categorized so both sides of the comparison are apples to
 * apples.
 */
function sumBillTotal(
  itemId: string,
  periodStart: string,
  periodEnd: string,
  groupFilter: ReturnType<typeof parseCardGroupFilter>,
): number {
  const row = db
    .prepare(
      `SELECT -COALESCE(SUM(t.amount), 0) AS total
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
