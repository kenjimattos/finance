# Sync, identity, and the bill engine

## Transaction identity model

`transactions.id` is a **locally-generated UUID** (stable forever). `provider_transaction_id` holds the Pluggy-issued ID, which Pluggy may recycle for unrelated purchases — and, on PicPay, re-mints for the *same* purchase on every daily scrape. On every sync, a SHA-256 identity hash (`date + amount + merchant_slug` — **no `account_id`**, so it is portable across reconnections) is compared to detect duplicates. The engine lives in [services/syncCreditTransactions.ts](../packages/api/src/services/syncCreditTransactions.ts) (fully unit-tested, with the corrupted payloads from the 2026-07 PicPay incident as fixtures). Outcomes:

1. **Provider ID found, hash matches ANY sibling row sharing that ID** (or stored hash is NULL — migrated rows before first sync) → update only mutable fields (`status`, `bill_id`, `raw_json`) on the matching sibling. User work (categories, splits, overrides) is untouched. Matching against all siblings — not just the newest — means a payload that flip-flops back to a previous generation's content refreshes that row instead of minting an endless chain of copies.
2. **Provider ID found, chimera payload** → **suppressed mutation**: the payload's `descriptionRaw` and `amount` still match the stored row while its display `description` names a different merchant (Pluggy half-rewrote a record in place — the 2026-07 incident). Nothing is minted; the row keeps its identity; the anomaly is logged once to `transaction_sync_conflicts` with `kind='mutation-suppressed'` (`new_transaction_id` NULL).
3. **Provider ID found, same amount + same slug, date moved ≤ 45 days** → **repost**: PENDING→POSTED replacing the purchase date with the posting date. Update in place (including date) and recompute any bill-shift override. Beyond 45 days (`REPOST_MAX_DAYS`) the "repost" is Pluggy re-dating a stale record — suppressed like outcome 2, so old categorized spend is never dragged into the open bill.
4. **Provider ID found, materially different content** → **recycled ID**: keep old row intact **with its user work attached**, insert new row with a new local UUID, write audit entry to `transaction_sync_conflicts` (`kind='recycled'`). The minted row is permanently excluded from learned-rule auto-categorization — it lands in the inbox for human review.
5. **Provider ID not found, hash matches an existing `pluggy` row with the SAME full timestamp** → **re-served purchase** (reconnect, or PicPay's daily ID rotation): update that row with the new provider ID instead of inserting a duplicate. The full-timestamp comparison is what separates this from a genuinely distinct second purchase at the same merchant for the same amount on the same day — re-served records preserve the instant to the millisecond; real duplicates differ in time-of-day and get their own row. Payloads without a parseable timestamp fall back to hash-only dedup.
6. **Provider ID not found, no hash match** → genuinely new transaction, insert (new local UUID).

All five FK tables (`transaction_categories`, `transaction_bill_overrides`, `transaction_description_overrides`, `bill_payment_tags`, `transaction_splits`) reference `transactions.id` (local UUID). Manual transactions have `provider_transaction_id = NULL`.

The same lookup-based logic runs in `POST /cashflow/sync` for `bank_transactions`.

## The open bill problem

**Pluggy's bills endpoint does not return open bills.** Open bills are not returned until closed or overdue; in-cycle transactions have `creditCardMetadata.billId === null`. The open bill window must be reconstructed on our side from the user-configured `closing_day` + `due_day`.

[billWindow.ts](../packages/api/src/services/billWindow.ts) computes bill windows from `closing_day` + `due_day`. The core primitive is `computeBillWindowAtOffset(settings, offset, today)` where `offset=0` is the currently open bill, `-N` walks N cycles into the past, and `+1` is the next bill. Convenience wrappers `computeOpenBillWindow` / `Previous` / `Next` delegate to it. `findOffsetForDueMonth(settings, targetYear, targetMonth, today)` resolves which offset produces a due date in a given calendar month — used by the Overview to map a single target month to per-account offsets. A lightweight frontend mirror lives in [packages/web/src/lib/billWindow.ts](../packages/web/src/lib/billWindow.ts). All date math uses `yyyy-mm-dd` strings via UTC — do not use local `Date` arithmetic here, it breaks around DST.

## Bill-cycle navigation

The dashboard supports navigating between bill cycles via ←/→ arrows. `GET /bills/current/breakdown?offset=N` accepts an integer offset (default 0). The frontend holds `billOffset` state in `AccountDashboard`, threads it through the query key and API call, and resets to 0 on account switch. The shift-aware SQL helpers don't change — they always receive three contiguous windows computed at `offset`, `offset-1`, `offset+1`.

## Bill-cycle shifts

Merchants sometimes submit transactions days after the purchase date, so a purchase made before the closing day can actually land on the next bill. The user fixes this per-transaction via `transaction_bill_overrides (transaction_id, shift)` where `shift ∈ {-1, 0, +1}`. The SQL for any bill window sums:

- unshifted rows whose date lies in `current`, **plus**
- rows with `shift = +1` whose date lies in `previous` (pushed forward into current), **plus**
- rows with `shift = -1` whose date lies in `next` (pulled back into current)

A shifted row disappears from the current-bill list and appears in the neighboring window. The previous-bill delta is computed with the plain unshifted sum — we deliberately don't chase shifts across two cycles (the comparison is already approximate, and double-shifts are vanishingly rare).

**UI model is additive:** the ⋯ menu buttons always add ±1 to the transaction's current `billShift` value, capped at ±1. This means "→ Próxima fatura" on an unshifted row sends `shift=+1`, but on a `shift=-1` row it sends `shift=0` ("restaurar") — the label changes accordingly. Buttons are disabled at the cap. The toast always offers undo, restoring the previous shift value.

## The categorized-only rule

**Only categorized transactions contribute to bill totals.** Uncategorized rows stay visible in the inbox but do not sum. This means fresh cards start at R$ 0 and grow as the user categorizes — the absence of a category is the exclusion mechanism for *not-yet-processed* rows. It also means the user can leave noise like "pagamento de fatura" or "Pagamento recebido" uncategorized and it naturally stays out.

The previous-period delta is also categorized-vs-categorized for consistency.

**Hidden transactions are excluded outright.** `transaction_hidden` (toggled via `PUT /transactions/:id/hidden`, "ocultar da fatura" in the row menu) marks a row as *not real* — phantom rows minted from corrupted Pluggy payloads, connector duplicates. Hidden rows are excluded from every bill computation (totals, category/installment breakdowns, split summaries, partner view, PDF reconciliation) but stay flagged in `GET /transactions` so the inbox lists them in a collapsed "Ocultadas" section, reversibly. Hiding differs from un-categorizing in one crucial way: `applyLearnedRules` skips hidden rows, so a learned rule can never re-categorize a phantom back into the totals on the next sync (and phantoms never bump `hit_count`). Un-categorizing alone is NOT a stable exclusion for any merchant that has a learned rule.

## The learning loop

Every manual categorization feeds a rules engine in [categorize.ts](../packages/api/src/routes/categorize.ts) + [merchantSlug.ts](../packages/api/src/services/merchantSlug.ts):

1. User assigns category Y to a transaction with description "IFOOD *RESTAURANTE XYZ".
2. `extractMerchantSlug()` normalizes the description — strips processor prefixes (`PAG*`, `EC*`, `DL*`), then handles the star separator: the first token after `*` is preserved when it's a meaningful qualifier (>= 3 alphabetic chars), otherwise discarded. This differentiates "UBER *EATS" → "UBER EATS" from "UBER *TRIP" → "UBER TRIP", while still collapsing "IFOOD *A" and "IFOOD *B" to "IFOOD". Finally drops trailing location tokens (BR, SAO PAULO…) and takes the first 5 tokens.
3. A row is upserted into `category_rules (merchant_slug, user_category_id)`.
4. On the next sync, `applyLearnedRules(itemId)` in [applyLearnedRules.ts](../packages/api/src/services/applyLearnedRules.ts) walks every uncategorized transaction, derives its slug, and applies the rule silently with `assigned_by = 'learned'`. When a slug maps to multiple categories, the rule with the highest `hit_count` wins (majority-wins resolution). A legacy slug fallback ensures old rules (keyed on pre-improvement slugs) keep matching.
5. If the user corrects a learned assignment by picking a different category, `override_count` on the offending rule is bumped.

Bulk categorize feeds the same engine — selecting 15 Uber Eats rows once trains 15 hits on the `UBER EATS → Delivery` rule. The frontend surfaces a small italic "auto" label next to learned assignments. A rules management overlay (`GET /rules?q=`, `PATCH /rules/:id`, `DELETE /rules/:id`) lets the user view, search, reassign, or delete learned rules explicitly.
