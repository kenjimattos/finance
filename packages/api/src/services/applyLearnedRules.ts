import type { Database } from 'better-sqlite3';
import { extractMerchantSlug, extractLegacySlug } from './merchantSlug.js';

/**
 * For every transaction belonging to this item that has no user category yet,
 * derive its merchant slug and look up a rule in `category_rules`. If a rule
 * exists, assign its category with `assigned_by = 'learned'`.
 *
 * ─── Invariant: NEVER overwrites an existing categorization ───────────────
 *
 * Two independent safeguards enforce this:
 *
 *   1. The candidates query filters with `WHERE t.category_id IS NULL`, so
 *      only transactions without a category enter the loop.
 *
 *   2. The assignment UPDATE repeats `AND category_id IS NULL`. Even if a
 *      candidate somehow slipped through (e.g. a race with a concurrent
 *      manual assignment), the update matches no row instead of replacing
 *      the existing category.
 *
 * Both layers exist on purpose. The filter is the fast path (zero writes
 * for already-categorized rows); the guarded UPDATE is the safety net. Do
 * NOT drop either — the applyLearnedRules.test.ts suite locks both
 * behaviors and would fail.
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
  // Hidden transactions are skipped: the user marked them as not-real, and
  // auto-categorizing one would also bump hit_count on the matched rule,
  // training the engine on phantom data.
  //
  // Conflict-minted rows (transaction_sync_conflicts.new_transaction_id) are
  // skipped too: they were born from an anomalous Pluggy payload — a recycled
  // ID or a mutated record — and must land in the inbox for HUMAN review
  // instead of silently entering the bill totals. This is permanent by
  // design: the 2026-07 PicPay incident put R$ 209,58 of phantoms straight
  // into the open bill precisely because learned rules categorized
  // conflict-minted rows on arrival.
  const candidates = db
    .prepare(
      `SELECT t.id, t.description
       FROM transactions t
       WHERE t.item_id = ? AND t.category_id IS NULL
         AND t.hidden_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM transaction_sync_conflicts c
           WHERE c.new_transaction_id = t.id
         )`,
    )
    .all(itemId) as Array<{ id: string; description: string | null }>;

  if (candidates.length === 0) return;

  // Load ALL rules — including previously "disabled" ones. The disabled flag
  // is no longer used for filtering (rules stay active regardless of override
  // count), but the column remains in the schema for historical tracking.
  //
  // ORDER BY hit_count DESC so the first row per slug is the majority
  // category. When a slug maps to multiple categories (e.g. a supermarket
  // categorized as both Alimentação and Casa), the highest-hit-count rule
  // wins. Subsequent rows for the same slug are skipped via Map.has().
  const ruleBySlug = new Map<string, number>();
  for (const row of db
    .prepare(
      // The JOIN skips a rule whose category is gone: assigning its id would
      // violate the transactions.category_id FK and abort the whole batch.
      `SELECT r.merchant_slug, r.user_category_id
       FROM category_rules r
       JOIN user_categories c ON c.id = r.user_category_id
       ORDER BY r.hit_count DESC`,
    )
    .all() as Array<{ merchant_slug: string; user_category_id: number }>) {
    if (!ruleBySlug.has(row.merchant_slug)) {
      ruleBySlug.set(row.merchant_slug, row.user_category_id);
    }
  }

  if (ruleBySlug.size === 0) return;

  const assign = db.prepare(
    `UPDATE transactions
     SET category_id = ?, category_assigned_by = 'learned', category_assigned_at = datetime('now')
     WHERE id = ? AND category_id IS NULL`,
  );
  const bumpRule = db.prepare(
    `UPDATE category_rules SET hit_count = hit_count + 1
     WHERE merchant_slug = ? AND user_category_id = ?`,
  );

  db.transaction(() => {
    for (const tx of candidates) {
      const slug = extractMerchantSlug(tx.description);
      const legacySlug = extractLegacySlug(tx.description);
      const matchedSlug = (slug && ruleBySlug.has(slug) ? slug : null)
        ?? (legacySlug && ruleBySlug.has(legacySlug) ? legacySlug : null);
      if (!matchedSlug) continue;
      const categoryId = ruleBySlug.get(matchedSlug)!;
      // A row categorized since the candidates query matches nothing here, and
      // must not count as a rule hit either.
      if (assign.run(categoryId, tx.id).changes === 0) continue;
      bumpRule.run(matchedSlug, categoryId);
    }
  })();
}
