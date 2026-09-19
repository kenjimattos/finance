# Database schema

SQLite via `better-sqlite3`. The actual `CREATE TABLE` statements and migration log live in [packages/api/src/db/index.ts](../packages/api/src/db/index.ts). This file is the conceptual map: which tables exist, why they're grouped the way they are, and the non-obvious constraints between them.

Column-level migrations use `addColumnIfMissing()` — append-only, idempotent via `PRAGMA table_info`. New tables use `CREATE TABLE IF NOT EXISTS` directly. Never delete or edit past migrations.

## Five domains, deliberately not merged

### 1. Pluggy credit cache

Tables: `items`, `accounts`, `transactions`, `bills`.

Read-through cache of CREDIT-account data. `accounts` is populated during sync from `fetchAccounts(itemId, 'CREDIT')` and `fetchAccounts(itemId, 'BANK')` — same table for both subtypes. BANK accounts carry `balance` and `subtype` (e.g. `CHECKING_ACCOUNT`). `raw_json` on each row keeps the full Pluggy payload so new fields can surface later without a backfill.

`transactions.source` distinguishes `'pluggy'` (synced) from `'manual'` (user-created). Manual transactions persist across re-syncs; Pluggy-sourced rows can be wiped and re-synced without losing user work because all user work lives in separate join tables keyed on the local UUID.

Two append-only tables log what the credit sync observed, so connector behavior can be studied from data rather than inferred from whatever `raw_json` last held: `sync_runs` (one row per account per sync, with served count and outcome counts) and `transaction_payloads` (every distinct payload served per provider ID, with the first and last sync run that carried it and the local row it was applied to). An unchanged payload only advances `last_seen_at` / `last_sync_run_id`, so the log grows with Pluggy's edits, not with sync frequency. No FK to `transactions` — the history outlives deleted rows. Nothing in the app reads these tables; they are for analysis.

### 2. Pluggy bank cache

Tables: `bank_transactions`, `bank_transaction_description_overrides`, `bank_bill_payment_tags`, `bank_transaction_hidden`, `balance_snapshots`, `balance_anchors`. Legacy: `bill_payment_tags`.

BANK-account transactions live in their own table to isolate CashFlow concerns from credit-card sync. Sister tables hold description overrides, the bill-payment tag (the clickable source column that links a bank outflow to a credit-card bill), and a hide flag for visually-duplicate rows the bank reported twice (hidden rows stay in `bank_transactions` so subsequent syncs still touch them).

Two tables anchor the CashFlow running balance, and the distinction matters:

- `balance_snapshots` — balances as Pluggy reported them at sync time. Untrusted: the live balance field oscillates for some connectors, and on Itaú it includes unposted yield cents that no transaction explains.
- `balance_anchors` — a balance the **user** confirmed for a given date, with a `source`. This is the *preferred* anchor; [routes/cashflow.ts](../packages/api/src/routes/cashflow.ts) falls back to a snapshot only when no anchor covers the period. Walking transactions forward from a user-confirmed anchor is more correct than trusting the connector's number.

`bill_payment_tags` is the pre-split credit-side ancestor of `bank_bill_payment_tags`. A migration in [db/index.ts](../packages/api/src/db/index.ts) copied its rows over and emptied it; the table survives only so the migration stays idempotent. Nothing reads it.

### 3. User configuration

Tables: `account_settings`, `card_groups`, `card_group_members`. Legacy: `card_settings` (per-item).

Per-account closing/due days (Pluggy does not expose these), plus the user's optional grouping of physical cards by `card_last4` scoped per account. Card groups are used only to filter the transaction list (chips above the inbox); they no longer drive per-card bill totals. One card belongs to at most one group — composite primary key on `card_group_members (account_id, card_last4)` enforces exclusivity. The legacy `card_settings` table remains for backward compat but the frontend writes to `account_settings`.

### 4. User work

Tables: `user_categories`, `transaction_categories`, `category_rules`, `transaction_bill_overrides`, `transaction_description_overrides`, `transaction_splits`, `transaction_hidden`, `transaction_sync_conflicts`.

Categorization, learned rules, manual bill-cycle shifts, description overrides, bill splitting, hidden rows, and recycled-ID sync audits. These are **separate join tables**, not columns on `transactions`, so a Pluggy re-sync never wipes them. `transaction_splits` only stores explicit shared markings (`'half'` = 50/50, `'theirs'` = partner owes 100%); categorized transactions without a split row are implicitly mine in split summaries.

`transaction_hidden` is the credit-side twin of `bank_transaction_hidden`: presence of a row means "this transaction is not real" (a phantom minted from a corrupted Pluggy payload, a connector duplicate). It is an exclusion that outranks categorization — hidden rows are dropped from every bill computation *and* skipped by `applyLearnedRules`, so a learned rule cannot re-categorize a phantom back into the totals on the next sync. See [sync.md](sync.md#the-categorized-only-rule).

### 5. Cash flow projections

Table: `manual_entries`.

Recurring entries (salary, rent, etc.) with `day_of_month` for placement. Each entry is scoped to a specific `month` (`YYYY-MM`) so each month edits independently; propagating a recurring item to the next month means creating it there too. `sort_key` (also on `bank_transactions`) enables drag-and-drop reordering within a day group; NULL means "natural order".

## Cascade-delete trap

Never use `INSERT OR REPLACE` on Pluggy cache tables. It internally DELETEs then INSERTs, which triggers `ON DELETE CASCADE` on join tables (`transaction_categories`, `transaction_bill_overrides`, etc.) and silently destroys user work. Always use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` instead — it updates in place without firing cascade deletes.
