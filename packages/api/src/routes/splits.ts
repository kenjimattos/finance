import { Router } from 'express';
import { z } from 'zod';
import { computeBillWindowAtOffset, resolveBillOffset } from '../services/billWindow.js';
import { loadAccountCardSettings } from '../db/cardSettings.js';

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

    db.prepare('UPDATE transactions SET split_type = ? WHERE id = ?').run(splitType, txId);

    res.json({ transactionId: txId, splitType });
  } catch (err) {
    next(err);
  }
});

// DELETE /transactions/:id/split — remove split marking
splitsRouter.delete('/transactions/:id/split', (req, res) => {
  const { db } = req;
  const info = db
    .prepare('UPDATE transactions SET split_type = NULL WHERE id = ? AND split_type IS NOT NULL')
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
      const stmt = db.prepare('UPDATE transactions SET split_type = ? WHERE id = ?');
      for (const txId of transactionIds) {
        applied += stmt.run(splitType, txId).changes;
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
        'UPDATE transactions SET split_type = NULL WHERE id = ? AND split_type IS NOT NULL',
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
    const { accountId, ...cycle } = z
      .object({
        accountId: z.string().min(1),
        offset: z.coerce.number().int().optional(),
        dueMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      })
      .parse(req.query);

    const s = loadAccountCardSettings(db, accountId);
    if (!s) {
      res.status(412).json({ error: 'AccountSettingsMissing' });
      return;
    }

    const offset = resolveBillOffset(s, cycle);
    if (offset === null) {
      res.status(404).json({ error: 'BillCycleNotFound', message: 'No bill cycle has its due date in that month.' });
      return;
    }
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
      AND t.hidden_at IS NULL
      AND (
           (t.bill_shift IS NULL AND t.date >= ? AND t.date <= ?)
        OR (t.bill_shift = 1  AND t.date >= ? AND t.date <= ?)
        OR (t.bill_shift = -1 AND t.date >= ? AND t.date <= ?)
      )`;

    // Split-marked transactions (half / theirs)
    const splitStmt = db.prepare(
      `SELECT t.id, t.date, t.description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              t.split_type,
              t.installment_number, t.total_installments,
              uc.id    AS user_category_id,
              uc.name  AS user_category_name,
              uc.color AS user_category_color
       FROM transactions t
       INNER JOIN user_categories uc ON uc.id = t.category_id
       WHERE ${windowClause}
         AND t.split_type IS NOT NULL
       ORDER BY t.date ASC, t.id ASC`,
    );

    // "Mine" = categorized transactions without a split_type
    const mineStmt = db.prepare(
      `SELECT t.id, t.date, t.description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              t.installment_number, t.total_installments,
              uc.id    AS user_category_id,
              uc.name  AS user_category_name,
              uc.color AS user_category_color
       FROM transactions t
       INNER JOIN user_categories uc ON uc.id = t.category_id
       WHERE ${windowClause}
         AND t.split_type IS NULL
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
