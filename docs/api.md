# API reference

Express routes mounted from [packages/api/src/index.ts](../packages/api/src/index.ts). All routes after `authMiddleware` require a valid session cookie when `APP_PASSWORD` is set. In production the SPA is served from the same origin and the `/api/` prefix is stripped before routing.

## Auth

- `GET /auth/me` — `{ authenticated, username?, demo?, features? }`. `demo: true` marks a sandboxed demo account; `features.importFaturaEnabled` gates the fatura-import button (always `false` for demo users). Authenticates unconditionally as the `default` user when no `USER_*_PASSWORD` is set (local dev).
- `POST /auth/login { username, password }` — sets the HTTP-only session cookie.
- `POST /auth/logout` — clears the cookie.

### Demo accounts

Usernames listed in `DEMO_USERS` (default: `demo`) get a 403 `DemoRestricted` from every route whose effect escapes their own SQLite file: `POST /connect-token`, `POST /items`, `DELETE /items/:id`, `POST /transactions/sync`, `POST /cashflow/sync`, `POST /transactions/import-fatura/*`, and `/admin/*`. `GET /items` stays allowed. Everything else (categorization, splits, manual entries, cash-flow edits) works normally; `npm run -w @finance/api seed:demo` resets the dataset.

## Connect / items

- `POST /connect-token` — short-lived JWT for the Pluggy Connect widget. Never cache; generate per session.
- `POST /items { itemId }` — backend validates via `pluggy.fetchItem()` and persists.
- `GET /items` — list all linked Pluggy items.
- `DELETE /items/:id` — removes a bank connection and all its data via cascade. Categories and rules are preserved.

## Accounts and settings

- `GET /accounts?itemId=...` — list accounts for the item. Frontend uses CREDIT accounts for billing and BANK accounts for cash flow.
- `GET /account-settings/:accountId` → 404 triggers the per-account setup form. In the Overview, unconfigured accounts render as "Configurar" cards.
- `PUT /account-settings/:accountId { closingDay, dueDay, displayName? }` — one-time config per account.

## Card groups

- `GET /card-groups?accountId=...` / `POST /card-groups` / `PUT /card-groups/:id` / `DELETE /card-groups/:id` — manage user groupings of physical cards by `card_last4`, scoped per account.

## Sync

- `POST /transactions/sync?itemId=...` — full sync: CREDIT and BANK accounts, bills (CREDIT only), and transactions (both types), then runs `applyLearnedRules`. Upserts discovered accounts into the `accounts` table with `balance` and `subtype`. Realigns `item_id` on existing transactions if the account moved between items (sandbox re-connection). Recycled-ID handling and PENDING→POSTED handling are described in [sync.md](sync.md).
- `POST /cashflow/sync` — BANK-only sync (cheaper).

## Bills

- `GET /bills/current/breakdown?itemId=...&accountId=...&offset=N` — one response with the bill window dates, neighbor windows, and account-level aggregates: `total`, `previousTotal`, `delta`, sorted `categories[]`, and `installments[]`. `offset` (default 0) selects the cycle: 0 = currently open, -N = N cycles in the past. The Overview fetches this in parallel for every account, resolving each account's offset via `findOffsetForDueMonth`.
- `GET /bills/current/split-summary?accountId=...&offset=N` — split transactions in the bill window with partner debt total, half/theirs/mine breakdowns, category totals, installments, and individual owes. Explicit split rows contribute to half/theirs; categorized rows without a split row contribute to mine.

## Transactions (credit)

- `GET /transactions` — accepts `itemId`, optional `accountId`, `from`/`to` plus the four neighbor-window params to run in shift-aware mode, returning a transaction list that matches the card totals exactly.
- `PUT /transactions/:id/category { categoryId }` / `POST /transactions/bulk-categorize` / `DELETE /transactions/:id/category` — the user's main interaction.
- `PUT /transactions/:id/bill-shift { shift: -1 | 0 | 1 }` — shift (or restore with 0) a single transaction.
- `PUT /transactions/:id/description { description }` / `DELETE /transactions/:id/description` — override or restore a transaction's display description.
- `POST /transactions/manual` / `PUT /transactions/manual/:id` / `DELETE /transactions/manual/:id` — CRUD for manual bill transactions (when Pluggy misses them). Stored in the `transactions` table with `source='manual'`. Form accepts day/month/year, credit or debit direction, and optional installment metadata. Edit/delete are guarded to only affect manual entries.
- `PUT /transactions/:id/split { splitType }` / `DELETE /transactions/:id/split` — mark or unmark a transaction as shared with the partner (`'half'` or `'theirs'`).
- `POST /transactions/bulk-split { transactionIds, splitType }` / `POST /transactions/bulk-unsplit { transactionIds }` — bulk split/unsplit.

## Categories and rules

- `GET /categories` / `POST /categories` / `PUT /categories/:id` / `DELETE /categories/:id` — flat list, system-assigned colors.
- `GET /rules?q=` / `PATCH /rules/:id` / `DELETE /rules/:id` — view, reassign, or delete learned merchant→category rules.

## Cash flow

- `GET /cashflow?month=YYYY-MM` — day-by-day timeline for a single month. Past days: actual BANK transactions, including user-hidden rows flagged `hidden: true` (they never contribute to opening/running balances; the frontend filters them behind a show/hide toggle). Future days: manual entries + credit card bill outflows on due dates. The frontend stitches several months together client-side.
- `GET /cashflow/range` — first and last `YYYY-MM` that have BANK transactions, used by the frontend to pick which months to render.
- `PUT /cashflow/bill-tag/:transactionId` / `DELETE /cashflow/bill-tag/:transactionId` — tag/untag a bank outflow as a credit-card bill payment (clickable source column in the ledger).
- `PUT /cashflow/hide/:transactionId` / `DELETE /cashflow/hide/:transactionId` — hide/unhide a bank row from CashFlow balances (for bank-side duplicates Pluggy passed through as distinct IDs). Row stays in `bank_transactions` so subsequent syncs still touch it, and stays in the `GET /cashflow` listing flagged `hidden` so the UI can display and restore it.
- `PUT /bank-transactions/:id/description` / `DELETE …/description` — override or restore a bank-row display description.
- `PUT /bank-transactions/:id/sort-key` / `PUT /manual-entries/:id/sort-key` — set the per-day ordering for drag-and-drop.
- `GET /manual-entries?month=YYYY-MM` / `POST /manual-entries` / `PUT /manual-entries/:id` / `DELETE /manual-entries/:id` / `POST /manual-entries/:id/duplicate` — CRUD for per-month recurring cash-flow entries, plus duplicate-into-next-month.
