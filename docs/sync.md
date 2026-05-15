# Sync, identity, and the bill engine

## Transaction identity model

`transactions.id` is a **locally-generated UUID** (stable forever). `provider_transaction_id` holds the Pluggy-issued ID, which Pluggy may recycle for unrelated purchases. On every sync, a SHA-256 identity hash (`date + amount + merchant_slug` — **no `account_id`**, so it is portable across reconnections) is compared to detect duplicates. Four outcomes:

1. **Provider ID found, hashes match** (or stored hash is NULL — migrated rows before first sync) → update only mutable fields (`status`, `bill_id`, `raw_json`). User work (categories, splits, overrides) is untouched.
2. **Provider ID found, hash mismatch** → **recycled ID**: keep old row intact, insert new row with a new local UUID, write audit entry to `transaction_sync_conflicts`. Before inserting, dependent joins (categories, splits, shifts, description overrides, bill-payment tags) attached to the stale row are cleared so old user work is not silently linked to the wrong transaction.
3. **Provider ID not found, hash matches an existing `pluggy` row** → **reconnect**: Pluggy issued new IDs for the same physical card. Update that row with the new provider ID instead of inserting a duplicate.
4. **Provider ID not found, no hash match** → genuinely new transaction, insert (new local UUID).

A row transitioning from `PENDING` → `POSTED` is treated as outcome 1 (update on the same UUID), not a recycled-ID conflict — the hash matches and only `status` changes.

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

**Only categorized transactions contribute to bill totals.** Uncategorized rows stay visible in the inbox but do not sum. This means fresh cards start at R$ 0 and grow as the user categorizes — the absence of a category is the exclusion mechanism, replacing any need for an "ignore" flag. It also means the user can leave noise like "pagamento de fatura" or "Pagamento recebido" uncategorized and it naturally stays out.

The previous-period delta is also categorized-vs-categorized for consistency.

## The learning loop

Every manual categorization feeds a rules engine in [categorize.ts](../packages/api/src/routes/categorize.ts) + [merchantSlug.ts](../packages/api/src/services/merchantSlug.ts):

1. User assigns category Y to a transaction with description "IFOOD *RESTAURANTE XYZ".
2. `extractMerchantSlug()` normalizes the description — strips processor prefixes (`PAG*`, `EC*`, `DL*`), then handles the star separator: the first token after `*` is preserved when it's a meaningful qualifier (>= 3 alphabetic chars), otherwise discarded. This differentiates "UBER *EATS" → "UBER EATS" from "UBER *TRIP" → "UBER TRIP", while still collapsing "IFOOD *A" and "IFOOD *B" to "IFOOD". Finally drops trailing location tokens (BR, SAO PAULO…) and takes the first 5 tokens.
3. A row is upserted into `category_rules (merchant_slug, user_category_id)`.
4. On the next sync, `applyLearnedRules(itemId)` in [applyLearnedRules.ts](../packages/api/src/services/applyLearnedRules.ts) walks every uncategorized transaction, derives its slug, and applies the rule silently with `assigned_by = 'learned'`. When a slug maps to multiple categories, the rule with the highest `hit_count` wins (majority-wins resolution). A legacy slug fallback ensures old rules (keyed on pre-improvement slugs) keep matching.
5. If the user corrects a learned assignment by picking a different category, `override_count` on the offending rule is bumped.

Bulk categorize feeds the same engine — selecting 15 Uber Eats rows once trains 15 hits on the `UBER EATS → Delivery` rule. The frontend surfaces a small italic "auto" label next to learned assignments. A rules management overlay (`GET /rules?q=`, `PATCH /rules/:id`, `DELETE /rules/:id`) lets the user view, search, reassign, or delete learned rules explicitly.
