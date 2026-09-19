# API reference

Express routes mounted from [packages/api/src/index.ts](../packages/api/src/index.ts). All routes after `authMiddleware` require a valid session cookie when at least one `USER_<NAME>_PASSWORD` is set; with none set the API authenticates everything as the `default` user (local dev). In production the SPA is served from the same origin and the `/api/` prefix is stripped before routing.

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
- `GET /card-settings/:itemId` / `PUT /card-settings/:itemId` — **legacy**, per-item instead of per-account. Still mounted and still backed by the `card_settings` table, but unreachable from the app: the frontend reads and writes `/account-settings/:accountId`, and the client methods for these two were deleted. Kept only because the table still holds pre-migration rows; delete both together when that stops being true.

## Cards

- `GET /cards?itemId=…&accountId=…` — the physical cards seen in the item's transactions (`cardLast4`, `txCount`, `lastUsed`, plus the group it belongs to), newest-used first. `accountId` is optional and narrows to one account. Feeds the card-group manager.
- `PUT /cards/:last4/group { itemId, cardGroupId }` — assign a card to a group; `cardGroupId: null` clears it. Membership is keyed on `(item_id, card_last4)`, so a card belongs to at most one group.

## Card groups

- `GET /card-groups?accountId=...` / `POST /card-groups` / `PUT /card-groups/:id` / `DELETE /card-groups/:id` — manage user groupings of physical cards by `card_last4`, scoped per account.

## Sync

- `POST /transactions/sync?itemId=...` — full sync: CREDIT and BANK accounts, bills (CREDIT only), and transactions (CREDIT only — BANK transactions go through `POST /cashflow/sync`), then runs `applyLearnedRules`. Upserts discovered accounts into the `accounts` table with `balance` and `subtype`, and snapshots BANK balances into `balance_snapshots`. Realigns `item_id` on existing transactions if the account moved between items (sandbox re-connection). Each CREDIT account's pages are collected first and upserted in one pass, recorded as one row in `sync_runs`, with every payload logged to `transaction_payloads`. Recycled-ID handling and PENDING→POSTED handling are described in [sync.md](sync.md).
- `POST /cashflow/sync` — BANK-only sync (cheaper).

## Bills

- `GET /bills?itemId=...` — the raw `bills` cache for an item (Pluggy's **closed** bills only), newest due date first. Diagnostic; no screen consumes it.
- `GET /bills/current/breakdown?itemId=...&accountId=...&offset=N` — one response with the bill window dates, neighbor windows, and account-level aggregates: `total`, `previousTotal`, `delta`, sorted `categories[]`, and `installments[]`. `offset` (default 0) selects the cycle: 0 = currently open, -N = N cycles in the past. The Overview fetches this in parallel for every account, resolving each account's offset via `findOffsetForDueMonth`.
- `GET /bills/current/split-summary?accountId=...&offset=N` — split transactions in the bill window with partner debt total, half/theirs/mine breakdowns, category totals, installments (each carrying its category so the UI can list the parcelas by category), and individual owes. Explicit split rows contribute to half/theirs; categorized rows without a split row contribute to mine.

## Transactions (credit)

- `GET /transactions` — accepts `itemId`, optional `accountId`, `from`/`to` plus the four neighbor-window params to run in shift-aware mode, returning a transaction list that matches the card totals exactly.
- `PUT /transactions/:id/category { categoryId }` / `POST /transactions/bulk-categorize` / `DELETE /transactions/:id/category` — the user's main interaction.
- `PUT /transactions/:id/bill-shift { shift: -1 | 0 | 1 }` — shift (or restore with 0) a single transaction.
- `PUT /transactions/:id/hidden { hidden: boolean }` — mark a row as *not real* (phantom from a corrupted payload, connector duplicate) or restore it. Hidden rows are excluded from every bill computation — totals, breakdowns, split summaries, partner view, reconciliation — and `applyLearnedRules` skips them, so a learned rule can never pull a phantom back into the totals. They stay in `GET /transactions` flagged `hidden: true` for the collapsed "Ocultas" section. See [sync.md](sync.md#the-categorized-only-rule).
- `PUT /transactions/:id/description { description }` / `DELETE /transactions/:id/description` — override or restore a transaction's display description.
- `POST /transactions/manual` / `PUT /transactions/manual/:id` / `DELETE /transactions/manual/:id` — CRUD for manual bill transactions (when Pluggy misses them). Stored in the `transactions` table with `source='manual'`. Form accepts day/month/year, credit or debit direction, and optional installment metadata. Edit/delete are guarded to only affect manual entries.
- `PUT /transactions/:id/split { splitType }` / `DELETE /transactions/:id/split` — mark or unmark a transaction as shared with the partner (`'half'` or `'theirs'`).
- `POST /transactions/bulk-split { transactionIds, splitType }` / `POST /transactions/bulk-unsplit { transactionIds }` — bulk split/unsplit.

## Fatura import and reconciliation

All three require `OPENAI_API_KEY` (plus `OPENAI_MODEL`); without it they return 503 and the frontend hides the buttons. Mounted with their own 25mb JSON limit (base64 images). Blocked for demo users.

- `POST /transactions/import-fatura/extract { accountId, billOffset, images[] }` — up to 20 base64 screenshots (`png`/`jpeg`/`webp`/`gif`) of the issuer's statement. The vision model returns structured rows (date, description, amount, card last4, installments, estorno→negative), each carrying the `billShift` that lands it in the viewed bill. Nothing is written — the rows go back for review. Prompt and `normalizeExtraction` live in [services/extractFatura.ts](../packages/api/src/services/extractFatura.ts).
- `POST /transactions/import-fatura/commit { accountId, rows[] }` — inserts up to 500 reviewed rows as `source='manual'` transactions, applying each row's `bill_shift`. Atomic: all-or-nothing. Rows land **uncategorized**, so they only start summing once categorized. No dedup against existing rows.
- `POST /transactions/import-fatura/reconcile { accountId, billOffset, pdfBase64 }` — reconciles the issuer's closed-bill PDF against the viewed bill. **The model does the judgment, code checks it.** One call ([services/reconcileFatura.ts](../packages/api/src/services/reconcileFatura.ts), model `OPENAI_RECONCILE_MODEL` ?? `OPENAI_MODEL`, strict JSON-schema output) receives the PDF itself plus the app's rows for the window (payments filtered out, referenced as `A1…An`) and returns every statement line with its printed `quote`, the printed net total with its label and a one-sentence reason (issuers disagree on which box holds it), each line's paired app ref, and a reason for each app row not on the statement. `buildReport` (pure, unit-tested) then verifies: refs exist and are used once, every app row is accounted for, per-pair diffs and the line sum are computed in code; failures surface as `warnings`, never silently dropped. Encrypted PDFs are decrypted in the browser with the user's password ([lib/pdfFile.ts](../packages/web/src/lib/pdfFile.ts), `@cantoo/pdf-lib`), so the endpoint only ever receives an unlocked copy and never the password. 10MB limit. Returns missing-in-app (insertable via `commit`, with `billShift`), amount mismatches, only-in-app with reasons, matched count, totals and warnings.

## Partner (shared cards, read-only)

Requires `USER_<NAME>_PARTNER` on both sides; the API verifies the partnership is mutual before reading the partner's SQLite file.

- `GET /partner/cards` — the partner's credit accounts the viewer may see.
- `GET /partner/cards/breakdown?owner=…&accountId=…&offset=N` — the same shape as `/bills/current/breakdown`, computed against the partner's database. Read-only: there is no write path into another user's file.

## Admin

- `POST /admin/restore-db` — overwrites the **authenticated user's** SQLite file with a raw binary body (up to 100mb), backing up the current file to `<name>.sqlite.bak.<timestamp>` and clearing stale WAL/SHM sidecars first. The server must be restarted afterwards to reopen the connection. Blocked for demo users.

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
- `GET /manual-entries?month=YYYY-MM` / `POST /manual-entries` / `PUT /manual-entries/:id` / `DELETE /manual-entries/:id` — CRUD for per-month recurring cash-flow entries. Each entry is scoped to one `YYYY-MM`; propagating a recurring item to the next month means creating it again there.
