import { Router } from 'express';
import { z } from 'zod';
import { computeBillWindowAtOffset } from '../services/billWindow.js';

export const splitsRouter = Router();

const splitTypeSchema = z.object({
  splitType: z.enum(['half', 'theirs']),
});

// PUT /transactions/:id/split — mark a transaction as shared
splitsRouter.put('/transactions/:id/split', (req, res, next) => {
  try {
    const { db } = req;
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
  const { db } = req;
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
  splitType: z.enum(['half', 'theirs']),
  transactionIds: z.array(z.string().min(1)).min(1).max(500),
});

// POST /transactions/bulk-split — mark many transactions at once
splitsRouter.post('/transactions/bulk-split', (req, res, next) => {
  try {
    const { db } = req;
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
    const { db } = req;
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
    const { db } = req;
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

    // Shift-aware 3-window params for an arbitrary cycle, so the same
    // queries can run for the current cycle and for the one before it
    // (used for the month-over-month category variation).
    const windowParamsAt = (off: number) => {
      const cur = computeBillWindowAtOffset(s, off);
      const prev = computeBillWindowAtOffset(s, off - 1);
      const nxt = computeBillWindowAtOffset(s, off + 1);
      return [
        accountId,
        cur.periodStart, cur.periodEnd,
        prev.periodStart, prev.periodEnd,
        nxt.periodStart, nxt.periodEnd,
      ];
    };
    const windowParams = windowParamsAt(offset);
    const prevWindowParams = windowParamsAt(offset - 1);

    const windowClause = `
      t.account_id = ?
      AND h.transaction_id IS NULL
      AND (
           (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
        OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
        OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
      )`;

    // Split-marked transactions (half / theirs)
    const splitStmt = db.prepare(
      `SELECT t.id, t.date, t.description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              sp.split_type,
              t.installment_number, t.total_installments,
              uc.id    AS user_category_id,
              uc.name  AS user_category_name,
              uc.color AS user_category_color
       FROM transactions t
       INNER JOIN transaction_splits sp ON sp.transaction_id = t.id
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       INNER JOIN user_categories       uc ON uc.id = tc.user_category_id
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       LEFT JOIN transaction_hidden h ON h.transaction_id = t.id
       WHERE ${windowClause}
       ORDER BY t.date ASC, t.id ASC`,
    );

    // "Mine" = categorized transactions WITHOUT a split row
    const mineStmt = db.prepare(
      `SELECT t.id, t.date, t.description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              t.installment_number, t.total_installments,
              uc.id    AS user_category_id,
              uc.name  AS user_category_name,
              uc.color AS user_category_color
       FROM transactions t
       INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
       INNER JOIN user_categories       uc ON uc.id = tc.user_category_id
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       LEFT JOIN transaction_splits     sp ON sp.transaction_id = t.id
       LEFT JOIN transaction_hidden h ON h.transaction_id = t.id
       WHERE ${windowClause}
         AND sp.transaction_id IS NULL
       ORDER BY t.date ASC, t.id ASC`,
    );

    const rows = splitStmt.all(...windowParams) as SplitSummaryRow[];
    const mineRows = mineStmt.all(...windowParams) as Array<Omit<SplitSummaryRow, 'split_type'>>;
    const prevRows = splitStmt.all(...prevWindowParams) as SplitSummaryRow[];
    const prevMineRows = mineStmt.all(...prevWindowParams) as Array<Omit<SplitSummaryRow, 'split_type'>>;

    let halfTotal = 0;
    let theirsTotal = 0;
    let mineTotal = 0;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const transactions = rows.map((r) => {
      const amt = Math.round(r.amount * 100) / 100;
      const owes =
        r.split_type === 'half'
          ? Math.round((r.amount / 2) * 100) / 100
          : amt;
      if (r.split_type === 'half') halfTotal += amt;
      else theirsTotal += amt;
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: amt,
        splitType: r.split_type as 'half' | 'theirs',
        owes,
        installmentNumber: r.installment_number,
        totalInstallments: r.total_installments,
      };
    });

    for (const r of mineRows) {
      mineTotal += Math.round(r.amount * 100) / 100;
    }

    // Previous-cycle share totals, so the UI can show a "vs anterior" delta
    // under the headline figures. Same per-row rounding as the current cycle.
    let prevHalfTotal = 0;
    let prevTheirsTotal = 0;
    let prevMineTotal = 0;
    for (const r of prevRows) {
      const amt = Math.round(r.amount * 100) / 100;
      if (r.split_type === 'half') prevHalfTotal += amt;
      else prevTheirsTotal += amt;
    }
    for (const r of prevMineRows) {
      prevMineTotal += Math.round(r.amount * 100) / 100;
    }

    // Category breakdown: group by category, full amounts (not halved).
    // Built for the current cycle and the previous one; the previous totals
    // ride along per category so the UI can show the month-over-month delta.
    type CatEntry = { id: number; name: string; color: string; halfTotal: number; theirsTotal: number; mineTotal: number };

    function addToCatMap(map: Map<number, CatEntry>, catId: number | null, catName: string | null, catColor: string | null, amount: number, type: 'half' | 'theirs' | 'mine') {
      if (catId == null) return;
      const existing = map.get(catId);
      if (existing) {
        if (type === 'half') existing.halfTotal += amount;
        else if (type === 'theirs') existing.theirsTotal += amount;
        else existing.mineTotal += amount;
      } else {
        map.set(catId, {
          id: catId,
          name: catName!,
          color: catColor!,
          halfTotal: type === 'half' ? amount : 0,
          theirsTotal: type === 'theirs' ? amount : 0,
          mineTotal: type === 'mine' ? amount : 0,
        });
      }
    }

    const categoryMap = new Map<number, CatEntry>();
    for (const r of rows) addToCatMap(categoryMap, r.user_category_id, r.user_category_name, r.user_category_color, r.amount, r.split_type as 'half' | 'theirs');
    for (const r of mineRows) addToCatMap(categoryMap, r.user_category_id, r.user_category_name, r.user_category_color, r.amount, 'mine');

    const prevCategoryMap = new Map<number, CatEntry>();
    for (const r of prevRows) addToCatMap(prevCategoryMap, r.user_category_id, r.user_category_name, r.user_category_color, r.amount, r.split_type as 'half' | 'theirs');
    for (const r of prevMineRows) addToCatMap(prevCategoryMap, r.user_category_id, r.user_category_name, r.user_category_color, r.amount, 'mine');

    const categories = Array.from(categoryMap.values())
      .map((c) => {
        const prev = prevCategoryMap.get(c.id);
        return {
          id: c.id,
          name: c.name,
          color: c.color,
          halfTotal: round2(c.halfTotal),
          theirsTotal: round2(c.theirsTotal),
          mineTotal: round2(c.mineTotal),
          total: round2(c.halfTotal + c.theirsTotal + c.mineTotal),
          prevHalfTotal: round2(prev?.halfTotal ?? 0),
          prevTheirsTotal: round2(prev?.theirsTotal ?? 0),
          prevMineTotal: round2(prev?.mineTotal ?? 0),
        };
      })
      .sort((a, b) => b.total - a.total);

    // Installments: from split rows + mine rows. Each carries its category so
    // the UI can offer a per-category view of the parcelas without a second
    // request (every row here is categorized — both queries INNER JOIN
    // user_categories — but the fields stay nullable to match the row type).
    const isInstallment = (r: { installment_number: number | null; total_installments: number | null }) =>
      r.installment_number != null && r.total_installments != null;
    const installmentCategory = (r: SplitSummaryRow | Omit<SplitSummaryRow, 'split_type'>) => ({
      categoryId: r.user_category_id,
      categoryName: r.user_category_name,
      categoryColor: r.user_category_color,
    });

    const installments = [
      ...rows
        .filter(isInstallment)
        .map((r) => ({
          id: r.id, date: r.date, description: r.description,
          amount: round2(r.amount),
          splitType: r.split_type as 'half' | 'theirs',
          installmentNumber: r.installment_number!,
          totalInstallments: r.total_installments!,
          ...installmentCategory(r),
        })),
      ...mineRows
        .filter(isInstallment)
        .map((r) => ({
          id: r.id, date: r.date, description: r.description,
          amount: round2(r.amount),
          splitType: 'mine' as const,
          installmentNumber: r.installment_number!,
          totalInstallments: r.total_installments!,
          ...installmentCategory(r),
        })),
    ];

    res.json({
      accountId,
      offset,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      dueDate: current.nextDueDate,
      totalSplitTransactions: transactions.length,
      partnerOwes: round2(halfTotal / 2 + theirsTotal),
      previousPartnerOwes: round2(prevHalfTotal / 2 + prevTheirsTotal),
      previousMyShare: round2(prevMineTotal + prevHalfTotal / 2),
      breakdown: {
        half: { count: rows.filter((r) => r.split_type === 'half').length, total: round2(halfTotal), owes: round2(halfTotal / 2) },
        theirs: { count: rows.filter((r) => r.split_type === 'theirs').length, total: round2(theirsTotal), owes: round2(theirsTotal) },
        mine: { count: mineRows.length, total: round2(mineTotal) },
      },
      previousBreakdown: {
        half: { total: round2(prevHalfTotal), owes: round2(prevHalfTotal / 2) },
        theirs: { total: round2(prevTheirsTotal), owes: round2(prevTheirsTotal) },
        mine: { total: round2(prevMineTotal) },
      },
      categories,
      installments,
      transactions,
    });
  } catch (err) {
    next(err);
  }
});
