import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { computeBillWindowAtOffset } from '../services/billWindow.js';

export const splitsRouter = Router();

const splitTypeSchema = z.object({
  splitType: z.enum(['half', 'theirs', 'mine']),
});

// PUT /transactions/:id/split — mark a transaction as shared
splitsRouter.put('/transactions/:id/split', (req, res, next) => {
  try {
    const { splitType } = splitTypeSchema.parse(req.body);
    const txId = req.params.id;

    const tx = db.prepare('SELECT id FROM transactions WHERE id = ?').get(txId);
    if (!tx) {
      res.status(404).json({ error: 'TransactionNotFound' });
      return;
    }

    db.prepare(
      `INSERT INTO transaction_splits (transaction_id, split_type)
       VALUES (?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET split_type = excluded.split_type`,
    ).run(txId, splitType);

    res.json({ transactionId: txId, splitType });
  } catch (err) {
    next(err);
  }
});

// DELETE /transactions/:id/split — remove split marking
splitsRouter.delete('/transactions/:id/split', (req, res) => {
  const info = db
    .prepare('DELETE FROM transaction_splits WHERE transaction_id = ?')
    .run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'NotSplit' });
    return;
  }
  res.status(204).send();
});

const bulkSplitSchema = z.object({
  splitType: z.enum(['half', 'theirs', 'mine']),
  transactionIds: z.array(z.string().min(1)).min(1).max(500),
});

// POST /transactions/bulk-split — mark many transactions at once
splitsRouter.post('/transactions/bulk-split', (req, res, next) => {
  try {
    const { splitType, transactionIds } = bulkSplitSchema.parse(req.body);

    let applied = 0;
    db.transaction(() => {
      const stmt = db.prepare(
        `INSERT INTO transaction_splits (transaction_id, split_type)
         VALUES (?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET split_type = excluded.split_type`,
      );
      for (const txId of transactionIds) {
        stmt.run(txId, splitType);
        applied++;
      }
    })();

    res.json({ applied });
  } catch (err) {
    next(err);
  }
});

// POST /transactions/bulk-unsplit — remove split from many transactions at once
const bulkUnsplitSchema = z.object({
  transactionIds: z.array(z.string().min(1)).min(1).max(500),
});

splitsRouter.post('/transactions/bulk-unsplit', (req, res, next) => {
  try {
    const { transactionIds } = bulkUnsplitSchema.parse(req.body);

    let removed = 0;
    db.transaction(() => {
      const stmt = db.prepare(
        'DELETE FROM transaction_splits WHERE transaction_id = ?',
      );
      for (const txId of transactionIds) {
        const info = stmt.run(txId);
        removed += info.changes;
      }
    })();

    res.json({ removed });
  } catch (err) {
    next(err);
  }
});

// ── Split summary for a bill cycle ─────���────────────────────────────────

interface SplitSummaryRow {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  split_type: string;
  installment_number: number | null;
  total_installments: number | null;
  user_category_id: number | null;
  user_category_name: string | null;
  user_category_color: string | null;
}

/**
 * GET /bills/current/split-summary?accountId=...&offset=N
 *
 * Returns split transactions in the bill window and totals for the partner.
 * Honors bill-shift overrides (same 3-window pattern as breakdown).
 */
splitsRouter.get('/bills/current/split-summary', (req, res, next) => {
  try {
    const { accountId, offset } = z
      .object({
        accountId: z.string().min(1),
        offset: z.coerce.number().int().default(0),
      })
      .parse(req.query);

    const settings = db
      .prepare('SELECT closing_day, due_day FROM account_settings WHERE account_id = ?')
      .get(accountId) as { closing_day: number; due_day: number } | undefined;
    if (!settings) {
      res.status(412).json({ error: 'AccountSettingsMissing' });
      return;
    }

    const s = { closingDay: settings.closing_day, dueDay: settings.due_day };
    const current = computeBillWindowAtOffset(s, offset);
    const previous = computeBillWindowAtOffset(s, offset - 1);
    const next = computeBillWindowAtOffset(s, offset + 1);

    const rows = db
      .prepare(
        `SELECT t.id, t.date, t.description,
                COALESCE(t.amount_in_account_currency, t.amount) AS amount,
                sp.split_type,
                t.installment_number, t.total_installments,
                uc.id    AS user_category_id,
                uc.name  AS user_category_name,
                uc.color AS user_category_color
         FROM transactions t
         INNER JOIN transaction_splits sp ON sp.transaction_id = t.id
         LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
         LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
         LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
         WHERE t.account_id = ?
           AND (
                (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
             OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
             OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
           )
         ORDER BY t.date ASC, t.id ASC`,
      )
      .all(
        accountId,
        current.periodStart, current.periodEnd,
        previous.periodStart, previous.periodEnd,
        next.periodStart, next.periodEnd,
      ) as SplitSummaryRow[];

    let halfTotal = 0;
    let theirsTotal = 0;
    let mineTotal = 0;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const transactions = rows.map((r) => {
      const amt = Math.round(r.amount * 100) / 100;
      const owes =
        r.split_type === 'half'
          ? Math.round((r.amount / 2) * 100) / 100
          : r.split_type === 'theirs'
            ? amt
            : 0;
      if (r.split_type === 'half') halfTotal += amt;
      else if (r.split_type === 'theirs') theirsTotal += amt;
      else mineTotal += amt;
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: amt,
        splitType: r.split_type as 'half' | 'theirs' | 'mine',
        owes,
        installmentNumber: r.installment_number,
        totalInstallments: r.total_installments,
      };
    });

    // Category breakdown: group by category, full amounts (not halved).
    // The split math (÷2 for half) only applies to the top-level totals.
    const categoryMap = new Map<number, { id: number; name: string; color: string; halfTotal: number; theirsTotal: number; mineTotal: number }>();
    for (const r of rows) {
      if (r.user_category_id == null) continue;
      const existing = categoryMap.get(r.user_category_id);
      if (existing) {
        if (r.split_type === 'half') existing.halfTotal += r.amount;
        else if (r.split_type === 'theirs') existing.theirsTotal += r.amount;
        else existing.mineTotal += r.amount;
      } else {
        categoryMap.set(r.user_category_id, {
          id: r.user_category_id,
          name: r.user_category_name!,
          color: r.user_category_color!,
          halfTotal: r.split_type === 'half' ? r.amount : 0,
          theirsTotal: r.split_type === 'theirs' ? r.amount : 0,
          mineTotal: r.split_type === 'mine' ? r.amount : 0,
        });
      }
    }
    const categories = Array.from(categoryMap.values())
      .map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        halfTotal: round2(c.halfTotal),
        theirsTotal: round2(c.theirsTotal),
        mineTotal: round2(c.mineTotal),
        total: round2(c.halfTotal + c.theirsTotal + c.mineTotal),
      }))
      .sort((a, b) => b.total - a.total);

    // Installments: full amounts (not halved)
    const installments = rows
      .filter((r) => r.installment_number != null && r.total_installments != null)
      .map((r) => ({
        id: r.id,
        date: r.date,
        description: r.description,
        amount: round2(r.amount),
        splitType: r.split_type as 'half' | 'theirs' | 'mine',
        installmentNumber: r.installment_number!,
        totalInstallments: r.total_installments!,
      }));

    res.json({
      accountId,
      offset,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      dueDate: current.nextDueDate,
      totalSplitTransactions: transactions.length,
      partnerOwes: round2(halfTotal / 2 + theirsTotal),
      breakdown: {
        half: { count: rows.filter((r) => r.split_type === 'half').length, total: round2(halfTotal), owes: round2(halfTotal / 2) },
        theirs: { count: rows.filter((r) => r.split_type === 'theirs').length, total: round2(theirsTotal), owes: round2(theirsTotal) },
        mine: { count: rows.filter((r) => r.split_type === 'mine').length, total: round2(mineTotal) },
      },
      categories,
      installments,
      transactions,
    });
  } catch (err) {
    next(err);
  }
});
