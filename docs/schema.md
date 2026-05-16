# Database schema

SQLite via `better-sqlite3`. The actual `CREATE TABLE` statements and migration log live in [packages/api/src/db/index.ts](../packages/api/src/db/index.ts). This file is the conceptual map: which tables exist, why they're grouped the way they are, and the non-obvious constraints between them.

Column-level migrations use `addColumnIfMissing()` — append-only, idempotent via `PRAGMA table_info`. New tables use `CREATE TABLE IF NOT EXISTS` directly. Never delete or edit past migrations.

## Five domains, deliberately not merged

### 1. Pluggy credit cache

Tables: `items`, `accounts`, `transactions`, `bills`.

Read-through cache of CREDIT-account data. `accounts` is populated during sync from `fetchAccounts(itemId, 'CREDIT')` and `fetchAccounts(itemId, 'BANK')` — same table for both subtypes. BANK accounts carry `balance` and `subtype` (e.g. `CHECKING_ACCOUNT`). `raw_json` on each row keeps the full Pluggy payload so new fields can surface later without a backfill.

`transactions.source` distinguishes `'pluggy'` (synced) from `'manual'` (user-created). Manual transactions persist across re-syncs; Pluggy-sourced rows can be wiped and re-synced without losing user work because all user work lives in separate join tables keyed on the local UUID.

### 2. Pluggy bank cache

Tables: `bank_transactions`, `bank_transaction_description_overrides`, `bank_bill_payment_tags`, `bank_transaction_hidden`, `balance_snapshots`.

BANK-account transactions live in their own table to isolate CashFlow concerns from credit-card sync. Sister tables hold description overrides, the bill-payment tag (the clickable source column that links a bank outflow to a credit-card bill), and a hide flag for visually-duplicate rows the bank reported twice (hidden rows stay in `bank_transactions` so subsequent syncs still touch them). `balance_snapshots` stores periodic account balances used to anchor the CashFlow running balance.

### 3. User configuration

Tables: `account_settings`, `card_groups`, `card_group_members`. Legacy: `card_settings` (per-item).

Per-account closing/due days (Pluggy does not expose these), plus the user's optional grouping of physical cards by `card_last4` scoped per account. Card groups are used only to filter the transaction list (chips above the inbox); they no longer drive per-card bill totals. One card belongs to at most one group — composite primary key on `card_group_members (account_id, card_last4)` enforces exclusivity. The legacy `card_settings` table remains for backward compat but the frontend writes to `account_settings`.

### 4. User work

Tables: `user_categories`, `transaction_categories`, `category_rules`, `transaction_bill_overrides`, `transaction_description_overrides`, `transaction_splits`, `transaction_sync_conflicts`.

Categorization, learned rules, manual bill-cycle shifts, description overrides, bill splitting, and recycled-ID sync audits. These are **separate join tables**, not columns on `transactions`, so a Pluggy re-sync never wipes them. `transaction_splits` only stores explicit shared markings (`'half'` = 50/50, `'theirs'` = partner owes 100%); categorized transactions without a split row are implicitly mine in split summaries.

### 5. Cash flow projections

Table: `manual_entries`.

Recurring entries (salary, rent, etc.) with `day_of_month` for placement. Each entry is scoped to a specific `month` (`YYYY-MM`) so each month edits independently — duplicate-to-next-month is the workflow for propagating recurring items. `sort_key` (also on `bank_transactions`) enables drag-and-drop reordering within a day group; NULL means "natural order".

## Cascade-delete trap

Never use `INSERT OR REPLACE` on Pluggy cache tables. It internally DELETEs then INSERTs, which triggers `ON DELETE CASCADE` on join tables (`transaction_categories`, `transaction_bill_overrides`, etc.) and silently destroys user work. Always use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` instead — it updates in place without firing cascade deletes.
