# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, single-user** credit card spending manager backed by [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). The value is not just viewing transactions — it's **categorizing them** with user-defined categories that the system learns to auto-apply, seeing the **currently open bill** with category breakdown and installment detail, and splitting shared spend with a partner. Each user runs their own copy with their own Pluggy credentials in `packages/api/.env`; there is no multi-tenant auth and adding one is not a goal.

## Transaction identity model

`transactions.id` is a **locally-generated UUID** (stable forever). `provider_transaction_id` holds the Pluggy-issued ID, which Pluggy may recycle for unrelated purchases. On every sync, a SHA-256 identity hash (`date + amount + merchant_slug` — **no `account_id`**, so it is portable across reconnections) is compared to detect duplicates. Four outcomes:

1. Provider ID found, hashes match (or stored hash is NULL — migrated rows before first sync) → update only mutable fields (`status`, `bill_id`, `raw_json`). User work (categories, splits, overrides) is untouched.
2. Provider ID found, hash mismatch → **recycled ID**: keep old row intact, insert new row with a new local UUID, write audit entry to `transaction_sync_conflicts`.
3. Provider ID not found, hash matches an existing `pluggy` row → **reconnect**: Pluggy issued new IDs for the same physical card. Update that row with the new provider ID instead of inserting a duplicate.
4. Provider ID not found, no hash match → genuinely new transaction, insert (new local UUID).

All five FK tables (`transaction_categories`, `transaction_bill_overrides`, `transaction_description_overrides`, `bill_payment_tags`, `transaction_splits`) reference `transactions.id` (local UUID). Manual transactions have `provider_transaction_id = NULL`.

## Current state

Functional end-to-end: connect card via `react-pluggy-connect` → sync discovers credit accounts → configure `closing_day` / `due_day` per account → sync bills and transactions from Pluggy → categorize transactions (with learning, bulk, and undo) → optionally group physical cards (titular, adicional, virtual…) per account to filter the transaction list → see the bill headline with total, delta vs previous cycle, and category breakdown → manually shift individual transactions to a neighboring bill cycle when the purchase date lies about when the charge actually lands → navigate between historical bill cycles via ←/→ arrows.

Multi-bank support: multiple Pluggy items (bank connections) are fully supported. The Overview screen groups all credit accounts by due-month with ←/→ navigation, shows a grand total with aggregated category breakdown and delta vs previous period, and lets the user drill into any account's Dashboard. New banks are added via "Adicionar banco" (PluggyConnect) and removed via "remover" (with cascade delete). A single Pluggy item can also contain multiple credit accounts (e.g. different card brands); each account has its own billing cycle, card groups, and bill window.

Cash flow: the CashFlow screen is the **top-level landing page**, showing a multi-month ledger from April 2026 through the current month + 2, all on one scrollable page. Past days display actual BANK transactions from Pluggy (editable descriptions). Future days show manual recurring entries (salary, rent) and credit card bill outflows on their due dates. Running balance carries across months. Clicking a credit card bill entry drills into the Overview for that month's bill detail.

Manual bill transactions: when Pluggy fails to return transactions (connector gaps), the user can add manual entries directly in the bill inbox. Manual entries are stored in the `transactions` table with `source='manual'` and participate in all bill window queries, categorization, and shifts. They can be edited/deleted via the `⋯` menu and are marked with an orange "manual" badge.

Bill splitting: transactions can be marked as shared with a partner — "½" (50/50) or "→dela" (partner owes 100%). Categorized transactions without a split row are implicitly "meu". Per-row actions in the ⋯ menu plus bulk split in the selection bar. The Dashboard shows a "Divisão" section below the card grid; the Overview shows an aggregated all-account "Divisão" section for the selected due month. Both separate ½, dela, and meu into dynamic columns with totals, category breakdowns, and installments. Data lives in a `transaction_splits` join table for explicit shared rows only (`'half'` / `'theirs'`) and survives re-syncs.

55 tests covering `billWindow` (including `findOffsetForDueMonth`), `merchantSlug`, and `applyLearnedRules`.

## Repository layout

npm workspaces monorepo:

- [packages/api](packages/api/) — Express + TypeScript + `pluggy-sdk` + `better-sqlite3`. All Pluggy communication and the SQLite cache.
- [packages/web](packages/web/) — Vite + React + TypeScript + Tailwind v4 + TanStack Query + Motion + `react-pluggy-connect`. Three screens: Overview (multi-bank month view), Dashboard (per-account bill view), and CashFlow (day-by-day checking account view).

Frontend-facing types live in [packages/web/src/lib/api.ts](packages/web/src/lib/api.ts) and are redeclared there to mirror the backend response shape. No shared package; extract one only when a second consumer appears.

## Common commands

Run from the repo root:

```bash
npm install                           # install all workspace deps
npm run dev                           # api (localhost:3333) + web (localhost:5174) in parallel
npm run dev:api                       # api only
npm run dev:web                       # web only
npm run build                         # tsc → api/dist, then vite build → web/dist
npm run typecheck                     # typecheck both workspaces
npm run -w @finance/api typecheck     # just the api
npm run -w @finance/web typecheck     # just the web
npm test                              # run api tests (node --test + tsx)
npm run -w @finance/api test          # same, explicit workspace
```

Both dev servers bind to `0.0.0.0`, so other devices on the local network can access the app via the host machine's IP (e.g. `http://192.168.1.x:5174`). Vite proxies `/api/*` → `http://localhost:3333` during dev so the frontend has no CORS dance. Tests use `node --test` with `tsx` as the ESM loader — no extra dependencies. Test files live next to the modules they cover (`*.test.ts`).

## Working style in this repo

**Commit as you go, not at the end.** For any task with more than ~2 logical steps, commit at each natural checkpoint where the code is coherent, typechecks, and represents a standalone unit of progress. Each commit: one logical change, descriptive body explaining *why*, `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer. Run `npm run typecheck` before committing.

**Trust the data, not the docs.** Pluggy's official docs and SDK README have been wrong multiple times for this project: `fetchAccounts` signature, `fetchBills`/`fetchCreditCardBills` naming, the sign convention of `Transaction.amount`. Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`, and when in doubt about data shape, query the actual SQLite cache: `sqlite3 packages/api/data/finance.sqlite "SELECT ..."`.

**Diagnose before changing code.** When the user reports "something isn't working", investigate the actual cause before proposing fixes. Ask what they see in the browser console / Network tab and which endpoint response is surprising. Don't jump to plausible-sounding hypotheses.

**Tailwind v4 "canonical classes" warnings are noise.** The IDE flags hundreds of `text-[color:var(--color-ink)]` → `text-(--color-ink)` suggestions. They are purely stylistic and pervasive across the whole codebase; don't treat them as errors and don't pause work to chase them. Real type errors come from `tsc`, not the editor's canonical-class linter.

**CLAUDE.md is a present-tense state doc.** No history, no anecdotes. When a feature lands, update the relevant section or delete what it invalidates. History goes in a future CHANGELOG, not here.

## Architecture

### Data model

Three independent domains in SQLite, deliberately not merged:

1. **Pluggy cache** (`items`, `accounts`, `transactions`, `bills`) — read-through cache of what Pluggy returns. `accounts` is populated during sync from `fetchAccounts(itemId, 'CREDIT')` and `fetchAccounts(itemId, 'BANK')`. BANK accounts carry `balance` and `subtype` (e.g. `CHECKING_ACCOUNT`). `raw_json` on each row keeps the full payload so new fields can surface later without a backfill. The `transactions.source` column distinguishes `'pluggy'` (synced) from `'manual'` (user-created). Manual transactions persist across re-syncs; Pluggy-sourced rows can be wiped and re-synced without losing user work.
2. **User configuration** (`account_settings`, `card_groups`, `card_group_members`) — per-account closing/due days (Pluggy does not expose these), plus the user's optional grouping of physical cards by `card_last4` scoped per account. Card groups are used only to filter the transaction list (chips above the inbox); they no longer drive per-card bill totals. One card belongs to at most one group (composite primary key enforces exclusivity). Legacy `card_settings` (per-item) table remains for backward compat but the frontend writes to `account_settings`.
3. **User work** (`user_categories`, `transaction_categories`, `category_rules`, `transaction_bill_overrides`, `transaction_description_overrides`, `transaction_splits`) — categorization, learned rules, manual bill-cycle shifts, description overrides, and bill splitting. These are **separate join tables**, not columns on `transactions`, so a Pluggy re-sync never wipes them. `transaction_splits` only stores explicit shared markings (`'half'` = 50/50, `'theirs'` = partner owes 100%); categorized transactions without a split row are implicitly mine in split summaries.
4. **Cash flow** (`manual_entries`) — monthly recurring entries (salary, rent, etc.) with `day_of_month` for placement. These are independent of Pluggy data and persist across re-syncs.

Column-level migrations use `addColumnIfMissing()` in [db/index.ts](packages/api/src/db/index.ts) — append-only, idempotent via `PRAGMA table_info`. New tables use `CREATE TABLE IF NOT EXISTS` directly.

### The open bill problem

**Pluggy's bills endpoint does not return open bills.** Open bills are not returned until closed or overdue; in-cycle transactions have `creditCardMetadata.billId === null`. The open bill window must be reconstructed on our side from the user-configured `closing_day` + `due_day`.

[billWindow.ts](packages/api/src/services/billWindow.ts) computes bill windows from `closing_day` + `due_day`. The core primitive is `computeBillWindowAtOffset(settings, offset, today)` where `offset=0` is the currently open bill, `-N` walks N cycles into the past, and `+1` is the next bill. Convenience wrappers `computeOpenBillWindow` / `Previous` / `Next` delegate to it. `findOffsetForDueMonth(settings, targetYear, targetMonth, today)` resolves which offset produces a due date in a given calendar month — used by the Overview to map a single target month to per-account offsets. A lightweight frontend mirror lives in [packages/web/src/lib/billWindow.ts](packages/web/src/lib/billWindow.ts). All date math uses `yyyy-mm-dd` strings via UTC — do not use local `Date` arithmetic here, it breaks around DST.

### Bill-cycle navigation

The dashboard supports navigating between bill cycles via ←/→ arrows. `GET /bills/current/breakdown?offset=N` accepts an integer offset (default 0). The frontend holds `billOffset` state in `AccountDashboard`, threads it through the query key and API call, and resets to 0 on account switch. The shift-aware SQL helpers don't change — they always receive three contiguous windows computed at `offset`, `offset-1`, `offset+1`.

### Bill-cycle shifts

Merchants sometimes submit transactions days after the purchase date, so a purchase made before the closing day can actually land on the next bill. The user fixes this per-transaction via `transaction_bill_overrides (transaction_id, shift)` where `shift ∈ {-1, 0, +1}`. The SQL for any bill window sums:

- unshifted rows whose date lies in `current`, **plus**
- rows with `shift = +1` whose date lies in `previous` (pushed forward into current), **plus**
- rows with `shift = -1` whose date lies in `next` (pulled back into current)

A shifted row disappears from the current-bill list and appears in the neighboring window. The previous-bill delta is computed with the plain unshifted sum — we deliberately don't chase shifts across two cycles (the comparison is already approximate, and double-shifts are vanishingly rare).

**UI model is additive:** the ⋯ menu buttons always add ±1 to the transaction's current `billShift` value, capped at ±1. This means "→ Próxima fatura" on an unshifted row sends `shift=+1`, but on a `shift=-1` row it sends `shift=0` ("restaurar") — the label changes accordingly. Buttons are disabled at the cap. The toast always offers undo, restoring the previous shift value.

### The categorized-only rule

**Only categorized transactions contribute to bill totals.** Uncategorized rows stay visible in the inbox but do not sum. This means fresh cards start at R$ 0 and grow as the user categorizes — the absence of a category is the exclusion mechanism, replacing any need for an "ignore" flag. It also means the user can leave noise like "pagamento de fatura" or "Pagamento recebido" uncategorized and it naturally stays out.

The previous-period delta is also categorized-vs-categorized for consistency.

### The learning loop

Every manual categorization feeds a rules engine in [categorize.ts](packages/api/src/routes/categorize.ts) + [merchantSlug.ts](packages/api/src/services/merchantSlug.ts):

1. User assigns category Y to a transaction with description "IFOOD *RESTAURANTE XYZ".
2. `extractMerchantSlug()` normalizes the description — strips processor prefixes (`PAG*`, `EC*`, `DL*`), then handles the star separator: the first token after `*` is preserved when it's a meaningful qualifier (>= 3 alphabetic chars), otherwise discarded. This differentiates "UBER *EATS" → "UBER EATS" from "UBER *TRIP" → "UBER TRIP", while still collapsing "IFOOD *A" and "IFOOD *B" to "IFOOD". Finally drops trailing location tokens (BR, SAO PAULO…) and takes the first 3 tokens.
3. A row is upserted into `category_rules (merchant_slug, user_category_id)`.
4. On the next sync, `applyLearnedRules(itemId)` in [applyLearnedRules.ts](packages/api/src/services/applyLearnedRules.ts) walks every uncategorized transaction, derives its slug, and applies the rule silently with `assigned_by = 'learned'`. When a slug maps to multiple categories, the rule with the highest `hit_count` wins (majority-wins resolution). A legacy slug fallback ensures old rules (keyed on pre-improvement slugs) keep matching.
5. If the user corrects a learned assignment by picking a different category, `override_count` on the offending rule is bumped.

Bulk categorize feeds the same engine — selecting 15 Uber Eats rows once trains 15 hits on the `UBER EATS → Delivery` rule. The frontend surfaces a small italic "auto" label next to learned assignments. A rules management overlay (`GET /rules?q=`, `PATCH /rules/:id`, `DELETE /rules/:id`) lets the user view, search, reassign, or delete learned rules explicitly.

### Request flow

1. `POST /connect-token` — short-lived JWT for the Pluggy Connect widget. Never cache; generate per session.
2. Frontend renders `<PluggyConnect>`. Rendering mounts the modal; unmounting closes it (no `isOpen` prop). `onSuccess({ item })` gives the `item.id`.
3. `POST /items { itemId }` — backend validates via `pluggy.fetchItem()` and persists.
4. `DELETE /items/:id` — removes a bank connection and all its data via cascade. Categories and rules are preserved.
5. `POST /transactions/sync?itemId=...` — syncs CREDIT and BANK accounts, bills (CREDIT only), and transactions (both types), then runs `applyLearnedRules`. Upserts discovered accounts into the `accounts` table with `balance` and `subtype`. Also realigns `item_id` on existing transactions if the account moved between items (sandbox re-connection). If Pluggy recycles a transaction ID for different content, sync clears dependent joins for the stale row before replacing it so old category/split work is not attached to the wrong transaction.
6. `GET /accounts?itemId=...` — list accounts for the item. Frontend uses CREDIT accounts for billing and BANK accounts for cash flow.
7. `GET /account-settings/:accountId` → 404 triggers the per-account setup form. In the Overview, unconfigured accounts render as "Configurar" cards.
8. `PUT /account-settings/:accountId { closingDay, dueDay, displayName? }` — one-time config per account.
9. `GET /bills/current/breakdown?itemId=...&accountId=...&offset=N` — one response with the bill window dates, neighbor windows, and the account-level aggregates: `total`, `previousTotal`, `delta`, sorted `categories[]`, and `installments[]`. `offset` (default 0) selects the cycle: 0 = currently open, -N = N cycles in the past. The Overview fetches this in parallel for every account, resolving each account's offset via `findOffsetForDueMonth`.
10. `GET /transactions` — accepts `itemId`, optional `accountId`, `from`/`to` plus the four neighbor-window params to run in shift-aware mode, returning a transaction list that matches the card totals exactly.
11. `PUT /transactions/:id/category { categoryId }` / `POST /transactions/bulk-categorize` / `DELETE /transactions/:id/category` — the user's main interaction.
12. `PUT /transactions/:id/bill-shift { shift: -1 | 0 | 1 }` — shift (or restore with 0) a single transaction.
13. `PUT /transactions/:id/description { description }` / `DELETE /transactions/:id/description` — override or restore a bank transaction's display description.
14. `POST /transactions/manual` / `PUT /transactions/manual/:id` / `DELETE /transactions/manual/:id` — CRUD for manual bill transactions (when Pluggy misses them). Stored in the `transactions` table with `source='manual'`. Edit/delete are guarded to only affect manual entries.
15. `GET /manual-entries` / `POST /manual-entries` / `PUT /manual-entries/:id` / `DELETE /manual-entries/:id` — CRUD for monthly recurring cash-flow entries.
16. `GET /cashflow` — day-by-day timeline for the current month. Past days: actual BANK transactions. Future days: manual entries + credit card bill outflows on due dates.
17. `PUT /transactions/:id/split { splitType }` / `DELETE /transactions/:id/split` — mark or unmark a transaction as shared with the partner (`'half'` or `'theirs'`).
18. `POST /transactions/bulk-split { transactionIds, splitType }` / `POST /transactions/bulk-unsplit { transactionIds }` — bulk split/unsplit.
19. `GET /bills/current/split-summary?accountId=...&offset=N` — split transactions in the bill window with partner debt total, half/theirs/mine breakdowns, category totals, installments, and individual owes. Explicit split rows contribute to half/theirs; categorized rows without a split row contribute to mine.

### Frontend design language

Editorial / financial-press. Light warm-paper background (`#fbf8f4`), warm near-black ink, single burnt-orange accent (`#c2410c`). No drop-shadow cards, no gradients, no rounded-xl anything. Aesthetic is "printed broadsheet", not "SaaS dashboard".

Type system:

- **Fraunces** (variable serif) — dominates the page. Used for every heading and for the bill headline (96px / 72px narrow) and account-card totals (40px).
- **JetBrains Mono** — currency and dates. `font-variant-numeric: tabular-nums` set project-wide for column alignment.
- **Inter** — small UI metadata only (labels, tiny hints).

Decoration: fixed CSS-only paper-grain noise overlay, fixed vertical margin rule at `left: 48px`, focus rings in the accent color, muted scrollbars. Motion is used sparingly — entrance fades for screens, slide-up for the bulk action bar and toast, card fade-in. No micro-animations scattered.

The app has three screens in a drill-down hierarchy: **CashFlow** → **Overview** → **Dashboard**. **CashFlow** (`CashFlow.tsx`) is the top-level landing page: multi-month financial ledger with columns (origem | dia | descrição | débito | crédito | saldo), bank transactions for past days, manual entries + credit card bill outflows for future days, running balance across months, inline editing of descriptions/amounts/dates, ghost row for adding new entries. Clicking a credit card bill drills into Overview. **Overview** (`Overview.tsx`): "← voltar" to CashFlow → ←/→ month navigation → grand total with delta → aggregated category breakdown → aggregated split section → grid of account cards + "adicionar banco" card. Clicking an account card drills into Dashboard. **Dashboard** (`Dashboard.tsx`): "← voltar" to Overview → account tabs (if multiple) → `BillHeader` (bill-cycle arrows, giant total, delta, closing/due dates, regras/sincronizar actions) → `SplitSummaryPanel` (partner debt breakdown) → `CardGroupFilterBar` (chips to filter the list by card group + "gerenciar" link) → `CategoryTabs` → `TransactionInbox`. App.tsx manages drill-down state: `overviewDrill` (year/month from CashFlow → Overview) and `drillDown` (itemId/accountId/offset from Overview → Dashboard).

### Reusable UI patterns

- **Portal for any overlay that needs to escape row stacking contexts.** Used by `CategoryPicker`, `RowActionsMenu`, `CardGroupsManager`, and `ToastLayer`. Common shape: `createPortal` into `document.body`, `getBoundingClientRect` via `useLayoutEffect` for position, `flip upward / right-align` when near edges, listeners for `mousedown` outside / `scroll` outside (scroll **inside** the overlay is explicitly allowed) / `resize` / `Escape`.
- **`ToastProvider`** in [Toast.tsx](packages/web/src/components/Toast.tsx) exposes `useToast()` with `show({ message, undo?, durationMs? })`. One toast at a time; a new one replaces the previous. Hover pauses the 6s countdown. Used after a shift so the user has a recovery window (no historical bill navigation yet).
- **`RowActionsMenu`** for rare per-row actions. Currently hosts bill-shift, manual-entry edit/delete, and split commands on each transaction row. Add more actions here before cluttering the row visually.

### Config boundary

[packages/api/src/config.ts](packages/api/src/config.ts) is the single place that reads `process.env`, validated with Zod. Everything else imports `config`. Missing/invalid env fails fast at boot.

## Conventions

- **ESM only.** `"type": "module"` in both packages. In the **api** package, relative imports must end in `.js` (e.g. `import { config } from './config.js'`) because NodeNext resolution needs the runtime extension. The **web** package uses Vite bundler resolution; extensions are optional.
- **Zod at the edges.** Validate request bodies and query strings with Zod in the route file. The global error handler in [packages/api/src/index.ts](packages/api/src/index.ts) turns `ZodError` into a 400. Don't catch validation errors locally.
- **Routes are thin.** Pure, testable logic (merchant slugging, bill-window math, color picking) lives under [packages/api/src/services/](packages/api/src/services/). Route files contain validation, SQL, and orchestration.
- **SQLite access is synchronous.** `better-sqlite3` is intentionally sync — no `await db.something()`. Wrap multi-row writes in `db.transaction(...)` for speed and atomicity.
- **Never use `INSERT OR REPLACE` on Pluggy cache tables.** It internally DELETEs then INSERTs, which triggers `ON DELETE CASCADE` on join tables (`transaction_categories`, `transaction_bill_overrides`) and silently destroys user work. Always use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` instead — it updates in place without firing cascade deletes.
- **Key on `t.type`, not on the sign of `t.amount`.** Pluggy's sign convention varies across connectors (Meu Pluggy: DEBIT positive / CREDIT negative). `tx.type === 'DEBIT'` is the stable way to know direction; reserve `SUM(amount)` for totals where the convention has already been verified.
- **`Transaction.date` from Pluggy is a `Date` object**, not a string. Normalize to `yyyy-mm-dd` at the storage boundary via `toYmd()` in [transactions.ts](packages/api/src/routes/transactions.ts). Every downstream date comparison assumes `yyyy-mm-dd` strings.

## Pluggy gotchas

- `fetchAccounts(itemId, 'CREDIT')` — positional second argument, not an options object.
- The bills method is `fetchCreditCardBills(accountId, options?)`, not `fetchBills`. It returns only **closed** bills; there is no `status` field and no "open bill" entity.
- `Transaction.amount` sign convention varies by connector. For Meu Pluggy credit accounts: `DEBIT` (purchases) = positive, `CREDIT` (refunds) = negative. Verify with a SQL query against the cache when in doubt; don't trust the SDK type doc comments.
- `Transaction.amountInAccountCurrency` contains the BRL equivalent for foreign-currency transactions (e.g. USD purchases). Stored in `amount_in_account_currency` column; all SUM queries and the GET /transactions endpoint use `COALESCE(amount_in_account_currency, amount)` so foreign transactions display and sum in BRL.
- `creditCardMetadata.billId` links a transaction to its closed bill, populated only after the bill closes.
- `creditCardMetadata.installmentNumber` / `totalInstallments` are populated for parceladas; these are already columns in the schema and surface in the split summary's installment sub-section.
- `creditCardMetadata.cardNumber` comes in inconsistent shapes across connectors (`"1234"`, `"****1234"`, `"1234 **** **** 5678"`). Normalized to last-4 via `lastFourDigits()` in [transactions.ts](packages/api/src/routes/transactions.ts).
- Pluggy embeds `PARCxx/yy` directly in `description` for installments (e.g. `MERCADO*MERCADPARC05/10`), which is redundant with the structured `installmentNumber`/`totalInstallments`. Stripped in the API layer (`shapeRow` in transactions.ts) so all consumers get clean descriptions. Not mutated in storage.
- **"Pagamento recebido" entries are Pluggy-internal reconciliation records**, not real bill items. They have no `card_last4` and don't appear on the actual card statement. The categorized-only rule naturally excludes them when left uncategorized.
- For installments, `transaction.date` is the **posting date** (when the installment hits the bill), not the original purchase date. The real bill statement shows the original purchase date, so dates will differ when comparing against exported statements.
- Connect tokens are short-lived (~20 min); generate per widget session.
- Webhooks require HTTPS; localhost is not accepted. Use manual `POST /transactions/sync` for local dev.

## Out of scope

- Multi-user auth, hosted multi-tenant deployment
- Docker, Fly, Vercel, or any deployment configs — user runs locally
- Graphs, charts, CSV export, full-text search
- Category hierarchy (categories are flat)
- Manual color picking for categories or card groups (system assigns from a curated palette)
