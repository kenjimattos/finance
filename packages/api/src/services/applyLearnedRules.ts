import type { Database } from 'better-sqlite3';
import { extractMerchantSlug } from './merchantSlug.js';

/**
 * For every transaction belonging to this item that has no user category yet,
 * derive its merchant slug and look up a rule in `category_rules`. If a rule
 * exists, assign its category with `assigned_by = 'learned'`.
 *
 * ─── Invariant: NEVER overwrites an existing categorization ───────────────
 *
 * Two independent safeguards enforce this:
 *
 *   1. The candidates query filters with `LEFT JOIN transaction_categories
 *      ... WHERE tc.transaction_id IS NULL`, so only transactions that have
 *      no row in `transaction_categories` enter the loop.
 *
 *   2. The insert uses `INSERT OR IGNORE`. Even if a candidate somehow
 *      slipped through (e.g. a race with a concurrent manual assignment),
 *      the conflict on the `transaction_id` primary key would cause the
 *      insert to be silently dropped instead of replacing the existing row.
 *
 * Both layers exist on purpose. The filter is the fast path (zero writes
 * for already-categorized rows); the `OR IGNORE` is the safety net. Do NOT
 * change the insert to `INSERT OR REPLACE` or remove the filter — the
 * applyLearnedRules.test.ts suite locks both behaviors and would fail.
 *
 * The reason this matters: the user manually corrects merchant categories
 * that the slug heuristic gets wrong (e.g. the same supermarket can be
 * Alimentação OR Casa depending on what was bought). A re-sync that
 * reverted those corrections would be infuriating and erode trust in the
 * learning loop. The contract is: a manual or bulk assignment is sacred,
 * and the system never touches it again unless the user explicitly
 * re-categorizes or deletes the assignment.
 */
export function applyLearnedRules(db: Database, itemId: string): void {
  const candidates = db
    .prepare(
      `SELECT t.id, t.description
       FROM transactions t
       LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
       WHERE t.item_id = ? AND tc.transaction_id IS NULL`,
    )
    .all(itemId) as Array<{ id: string; description: string | null }>;

  if (candidates.length === 0) return;

  // Load ALL rules — including previously "disabled" ones. The disabled flag
  // is no longer used for filtering (rules stay active regardless of override
  // count), but the column remains in the schema for historical tracking.
  const ruleBySlug = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT merchant_slug, user_category_id
       FROM category_rules`,
    )
    .all() as Array<{ merchant_slug: string; user_category_id: number }>) {
    ruleBySlug.set(row.merchant_slug, row.user_category_id);
  }

  if (ruleBySlug.size === 0) return;

  const assign = db.prepare(
    `INSERT OR IGNORE INTO transaction_categories
       (transaction_id, user_category_id, assigned_by)
     VALUES (?, ?, 'learned')`,
  );
  const bumpRule = db.prepare(
    `UPDATE category_rules SET hit_count = hit_count + 1
     WHERE merchant_slug = ? AND user_category_id = ?`,
  );

  db.transaction(() => {
    for (const tx of candidates) {
      const slug = extractMerchantSlug(tx.description);
      if (!slug) continue;
      const categoryId = ruleBySlug.get(slug);
      if (!categoryId) continue;
      assign.run(tx.id, categoryId);
      bumpRule.run(slug, categoryId);
    }
  })();
}
