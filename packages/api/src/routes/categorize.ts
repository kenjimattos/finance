import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { extractMerchantSlug } from '../services/merchantSlug.js';

export const categorizeRouter = Router();

/**
 * Categorization endpoints — the learning loop lives here.
 *
 * Every manual assignment feeds the rules engine: we extract the merchant
 * slug from the transaction's description and upsert a row in category_rules
 * so future transactions with the same slug get auto-applied during sync.
 *
 * Override semantics (as specified): if a learned assignment is overridden
 * by the user, we bump override_count on the offending rule. After 2
 * overrides the rule flips to disabled=1 and stops firing.
 */

const assignSchema = z.object({
  categoryId: z.number().int().positive(),
});

// PUT /transactions/:id/category — assign a single transaction
categorizeRouter.put('/transactions/:id/category', (req, res, next) => {
  try {
    const { categoryId } = assignSchema.parse(req.body);
    const transactionId = req.params.id;
    const result = assignCategory(transactionId, categoryId, 'manual');
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.row);
  } catch (err) {
    next(err);
  }
});

// DELETE /transactions/:id/category — remove a user category assignment
categorizeRouter.delete('/transactions/:id/category', (req, res) => {
  // Note: we do NOT bump override_count here, because a bare "uncategorize"
  // is different from "replace with a different category". If the user
  // wants to correct a learned guess, they should re-assign, not just clear.
  const info = db
    .prepare('DELETE FROM transaction_categories WHERE transaction_id = ?')
    .run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'NotAssigned' });
    return;
  }
  res.status(204).send();
});

const bulkSchema = z.object({
  categoryId: z.number().int().positive(),
  transactionIds: z.array(z.string().min(1)).min(1).max(500),
});

// POST /transactions/bulk-categorize — assign many at once
categorizeRouter.post('/transactions/bulk-categorize', (req, res, next) => {
  try {
    const { categoryId, transactionIds } = bulkSchema.parse(req.body);

    // Verify category exists
    const category = db
      .prepare('SELECT id FROM user_categories WHERE id = ?')
      .get(categoryId);
    if (!category) {
      res.status(404).json({ error: 'CategoryNotFound' });
      return;
    }

    let applied = 0;
    db.transaction(() => {
      for (const txId of transactionIds) {
        const result = assignCategoryInTransaction(txId, categoryId, 'bulk');
        if (result.ok) applied++;
      }
    })();

    res.json({ ok: true, applied, total: transactionIds.length });
  } catch (err) {
    next(err);
  }
});

// GET /rules — list active auto-categorization rules (for a settings screen later)
categorizeRouter.get('/rules', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.merchant_slug, r.hit_count, r.override_count, r.disabled,
              r.user_category_id, uc.name AS user_category_name, uc.color AS user_category_color,
              r.created_at
       FROM category_rules r
       JOIN user_categories uc ON uc.id = r.user_category_id
       ORDER BY r.disabled ASC, r.hit_count DESC`,
    )
    .all();
  res.json(rows);
});

// DELETE /rules/:id — forget a rule entirely
categorizeRouter.delete('/rules/:id', (req, res) => {
  const info = db
    .prepare('DELETE FROM category_rules WHERE id = ?')
    .run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'NotFound' });
    return;
  }
  res.status(204).send();
});

// -----------------------------------------------------------------------------
// Shared assignment logic
// -----------------------------------------------------------------------------

type AssignOk = { ok: true; row: unknown };
type AssignErr = { ok: false; status: number; error: string };
type AssignResult = AssignOk | AssignErr;

function assignCategory(
  transactionId: string,
  categoryId: number,
  assignedBy: 'manual' | 'bulk',
): AssignResult {
  let result: AssignResult = { ok: false, status: 500, error: 'Unknown' };
  db.transaction(() => {
    result = assignCategoryInTransaction(transactionId, categoryId, assignedBy);
  })();
  return result;
}

/**
 * Core assignment logic, expected to be called inside a db.transaction(...).
 * Returns a result object rather than throwing so the bulk path can count
 * successes without aborting the whole batch on one missing row.
 */
function assignCategoryInTransaction(
  transactionId: string,
  categoryId: number,
  assignedBy: 'manual' | 'bulk',
): AssignResult {
  const tx = db
    .prepare('SELECT id, description FROM transactions WHERE id = ?')
    .get(transactionId) as { id: string; description: string | null } | undefined;
  if (!tx) return { ok: false, status: 404, error: 'TransactionNotFound' };

  const category = db
    .prepare('SELECT id, name, color FROM user_categories WHERE id = ?')
    .get(categoryId);
  if (!category) return { ok: false, status: 404, error: 'CategoryNotFound' };

  // Was there a previous assignment? If so, and it was 'learned' with a
  // different category, this counts as an override — bump the rule.
  const previous = db
    .prepare(
      `SELECT user_category_id, assigned_by
       FROM transaction_categories
       WHERE transaction_id = ?`,
    )
    .get(transactionId) as
    | { user_category_id: number; assigned_by: string }
    | undefined;

  const slug = extractMerchantSlug(tx.description);

  if (
    previous &&
    previous.assigned_by === 'learned' &&
    previous.user_category_id !== categoryId &&
    slug
  ) {
    // User is correcting a learned guess — penalize the old rule.
    db.prepare(
      `UPDATE category_rules
         SET override_count = override_count + 1,
             disabled = CASE WHEN override_count + 1 >= 2 THEN 1 ELSE disabled END
       WHERE merchant_slug = ? AND user_category_id = ?`,
    ).run(slug, previous.user_category_id);
  }

  // Upsert the assignment (REPLACE lets the user switch categories freely)
  db.prepare(
    `INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by)
     VALUES (?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       user_category_id = excluded.user_category_id,
       assigned_by      = excluded.assigned_by,
       assigned_at      = datetime('now')`,
  ).run(transactionId, categoryId, assignedBy);

  // Bump the category's usage count (used for ordering the picker)
  db.prepare(
    `UPDATE user_categories SET usage_count = usage_count + 1 WHERE id = ?`,
  ).run(categoryId);

  // Feed the rules engine: upsert a (merchant_slug, category) rule. Using the
  // UNIQUE (merchant_slug, user_category_id) index means repeated assignments
  // to the same slug+category just bump hit_count, while a different category
  // for the same slug creates a new row. In practice only the most-used rule
  // per slug survives because applyLearnedRules picks the first match.
  if (slug) {
    db.prepare(
      `INSERT INTO category_rules (merchant_slug, user_category_id, hit_count)
       VALUES (?, ?, 1)
       ON CONFLICT(merchant_slug, user_category_id) DO UPDATE SET
         hit_count = hit_count + 1,
         disabled  = 0`,
    ).run(slug, categoryId);
  }

  return {
    ok: true,
    row: {
      transactionId,
      category,
      assignedBy,
      learnedSlug: slug,
    },
  };
}
