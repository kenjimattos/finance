# Database schema

SQLite via `better-sqlite3`. The actual `CREATE TABLE` statements and migration log live in [packages/api/src/db/index.ts](../packages/api/src/db/index.ts). This file is the conceptual map: which tables exist, why they're grouped the way they are, and the non-obvious constraints between them.

Column-level migrations use `addColumnIfMissing()` — append-only, idempotent via `PRAGMA table_info`. New tables use `CREATE TABLE IF NOT EXISTS` directly. Never delete or edit past migrations.

## Five domains, deliberately not merged

### 1. Pluggy credit cache

Tables: `items`, `accounts`, `transactions`, `bills`.

Read-through cache of CREDIT-account data. `accounts` is populated during sync from `fetchAccounts(itemId, 'CREDIT')` and `fetchAccounts(itemId, 'BANK')` — same table for both subtypes. BANK accounts carry `balance` and `subtype` (e.g. `CHECKING_ACCOUNT`). `raw_json` on each row keeps the full Pluggy payload so new fields can surface later without a backfill.

`transactions.source` distinguishes `'pluggy'` (synced) from `'manual'` (user-created). Manual transactions persist across re-syncs. User work lives in columns of the same row (see [User work](#4-user-work)); the sync never writes those columns.

Two append-only tables log what the credit sync observed, so connector behavior can be studied from data rather than inferred from whatever `raw_json` last held: `sync_runs` (one row per account per sync, with served count and outcome counts) and `transaction_payloads` (every distinct payload served per provider ID, with the first and last sync run that carried it and the local row it was applied to). An unchanged payload only advances `last_seen_at` / `last_sync_run_id`, so the log grows with Pluggy's edits, not with sync frequency. No FK to `transactions` — the history outlives deleted rows. Nothing in the app reads these tables; they are for analysis.

### 2. Pluggy bank cache

Tables: `bank_transactions`, `balance_snapshots`, `balance_anchors`.

BANK-account transactions live in their own table to isolate CashFlow concerns from credit-card sync. The user's work on a bank row is four columns the cashflow sync never writes: `sort_key` (drag order), `description_override`, `bill_payment_tagged_at` (the bill-payment tag — the clickable source column that links a bank outflow to a credit-card bill) and `hidden_at`, a hide flag for visually-duplicate rows the bank reported twice (hidden rows stay in `bank_transactions` so subsequent syncs still touch them).

Two tables anchor the CashFlow running balance, and the distinction matters:

- `balance_snapshots` — balances as Pluggy reported them at sync time. Untrusted: the live balance field oscillates for some connectors, and on Itaú it includes unposted yield cents that no transaction explains.
- `balance_anchors` — a balance the **user** confirmed for a given date, with a `source`. This is the *preferred* anchor; [routes/cashflow.ts](../packages/api/src/routes/cashflow.ts) falls back to a snapshot only when no anchor covers the period. Walking transactions forward from a user-confirmed anchor is more correct than trusting the connector's number.

### 3. User configuration

Tables: `account_settings`, `bill_cycle_overrides`, `card_groups`, `card_group_members`.

Per-account closing/due days (Pluggy does not expose these), with `bill_cycle_overrides (account_id, cycle_month)` holding a different closing and/or due date for a single cycle (NULL = the default; see [sync.md](sync.md#per-cycle-closing-and-due-dates)), plus the user's optional grouping of physical cards by `card_last4` scoped per account. Card groups are used only to filter the transaction list (chips above the inbox); they no longer drive per-card bill totals. One card belongs to at most one group — composite primary key on `card_group_members (account_id, card_last4)` enforces exclusivity.

### 4. User work

Tables: `user_categories`, `category_rules`, `transaction_sync_conflicts`, plus the user-work columns of `transactions`.

What the user does to a single transaction is a column on its row:

| column | meaning |
| --- | --- |
| `category_id` → `user_categories` (`ON DELETE SET NULL`), `category_assigned_by` (`manual` / `bulk` / `learned`), `category_assigned_at` | categorization; NULL = inbox, contributes nothing to totals |
| `bill_shift` | ±1 to show the row on a neighboring bill; NULL = natural cycle |
| `split_type` | `'half'` (50/50) or `'theirs'` (partner owes 100%); NULL = implicitly mine in split summaries |
| `hidden_at` | not a real transaction |
| `description_override` | display name |

**The sync never writes these columns.** That is the whole guarantee that a re-sync keeps user work: [syncCreditTransactions.ts](../packages/api/src/services/syncCreditTransactions.ts) updates only Pluggy-owned fields (status, bill, hash, payload, dates, provider ID), and the "user work columns" block of its test suite runs every engine outcome over a row carrying all of them. A recycled provider ID mints a new row, so the old purchase keeps its work and the new one starts clean. Until `user_version` 2 these lived in 1:1 join tables (`transaction_categories`, `transaction_bill_overrides`, …); the migration in [db/index.ts](../packages/api/src/db/index.ts) folded them in and dropped them.

`category_rules` and `transaction_sync_conflicts` stay tables: a slug maps to many categories, and a conflict is an event log, not a property of one row.

`hidden_at` is the credit-side twin of `bank_transactions.hidden_at`: it means "this transaction is not real" (a phantom minted from a corrupted Pluggy payload, a connector duplicate). It is an exclusion that outranks categorization — hidden rows are dropped from every bill computation *and* skipped by `applyLearnedRules`, so a learned rule cannot re-categorize a phantom back into the totals on the next sync. See [sync.md](sync.md#the-categorized-only-rule).

### 5. Cash flow projections

Table: `manual_entries`.

Recurring entries (salary, rent, etc.) with `day_of_month` for placement. Each entry is scoped to a specific `month` (`YYYY-MM`) so each month edits independently; propagating a recurring item to the next month means creating it there too. `sort_key` (also on `bank_transactions`) enables drag-and-drop reordering within a day group; NULL means "natural order".

## REPLACE trap

Never use `INSERT OR REPLACE` on Pluggy cache tables. It internally DELETEs then INSERTs: on `transactions` / `bank_transactions` the new row comes back without the user-work columns, and on parents (`items`, `accounts`) the DELETE fires `ON DELETE CASCADE` on everything below — accounts, settings, bank rows, balance anchors. Always use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` instead; it updates in place, touches only the listed columns, and fires no cascade.
