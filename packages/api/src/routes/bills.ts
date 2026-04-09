import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { computeOpenBillWindow, computePreviousBillWindow } from '../services/billWindow.js';

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

// GET /bills/current?itemId=...
// Returns the *open* bill window (computed, not stored) plus its running total
// and a comparison against the previous bill window. This is the main summary
// card the frontend renders at the top of the screen.
billsRouter.get('/bills/current', (req, res, next) => {
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

    // Transactions amounts are negative for outflows (purchases) and positive
    // for inflows (refunds, credits). We want the total owed, which is the
    // sum of all amounts INVERTED — a R$100 purchase contributes +100 to the
    // bill total. We cast via -SUM() so the response is "how much you owe".
    const currentTotal =
      (db
        .prepare(
          `SELECT -COALESCE(SUM(amount), 0) AS total
           FROM transactions
           WHERE item_id = ?
             AND date >= ?
             AND date <= ?`,
        )
        .get(itemId, current.periodStart, current.periodEnd) as SumRow).total ?? 0;

    const previousTotal =
      (db
        .prepare(
          `SELECT -COALESCE(SUM(amount), 0) AS total
           FROM transactions
           WHERE item_id = ?
             AND date >= ?
             AND date <= ?`,
        )
        .get(itemId, previous.periodStart, previous.periodEnd) as SumRow).total ?? 0;

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
