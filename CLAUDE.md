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

A separate `bank_transactions` table (with its own sister tables `bank_transaction_description_overrides`, `bank_bill_payment_tags`, `bank_transaction_hidden`) holds BANK-account rows for the CashFlow ledger. The two domains were split so credit-card sync logic can never accidentally touch checking-account work, and so the bank table can carry CashFlow-only concerns (sort_key, hide flag) without polluting the credit-card schema. A row transitioning from `PENDING` → `POSTED` is treated as an update on the same local UUID, not a recycled-ID conflict — the hash matches and only `status` changes.

## Current state

Functional end-to-end: connect card via `react-pluggy-connect` → sync discovers credit accounts → configure `closing_day` / `due_day` per account → sync bills and transactions from Pluggy → categorize transactions (with learning, bulk, and undo) → optionally group physical cards (titular, adicional, virtual…) per account to filter the transaction list → see the bill headline with total, delta vs previous cycle, and category breakdown → manually shift individual transactions to a neighboring bill cycle when the purchase date lies about when the charge actually lands → navigate between historical bill cycles via ←/→ arrows.

Multi-bank support: multiple Pluggy items (bank connections) are fully supported. The Overview screen groups all credit accounts by due-month with ←/→ navigation, shows a grand total with aggregated category breakdown and delta vs previous period, and lets the user drill into any account's Dashboard. New banks are added via "Adicionar banco" (PluggyConnect) and removed via "remover" (with cascade delete). A single Pluggy item can also contain multiple credit accounts (e.g. different card brands); each account has its own billing cycle, card groups, and bill window.

Cash flow: the CashFlow screen is the **top-level landing page**, showing a multi-month ledger spanning the months that have BANK transaction data plus a configurable number of projection months ahead, all on one scrollable page. Past days display actual BANK transactions from Pluggy (editable descriptions, draggable to reorder within a day, hideable when the bank reports visual duplicates). Future days show per-month manual recurring entries (salary, rent — each month edits independently) and credit card bill outflows on their due dates. Running balance carries across months with a single global realized/projected boundary. Rows can be dragged to reorder within their day group via `sort_key`. Clicking a credit card bill entry drills into the Overview for that month's bill detail.

Auth: the API is password-gated when `APP_PASSWORD` is set in `packages/api/.env`. The frontend renders a Login screen until `/auth/me` reports authenticated; the session lives in an HTTP-only cookie. When `APP_PASSWORD` is unset (local dev), auth is bypassed entirely.

Deployment: a Railway/Nixpacks config is checked in. In production, Express serves the built SPA from `packages/web/dist` on the same origin and strips the `/api/` prefix before routing, so the frontend can call `/api/*` without a separate host. `DATABASE_PATH` is a required env var (no default) — point it at a persistent volume.

Manual bill transactions: when Pluggy fails to return transactions (connector gaps), the user can add manual entries directly in the bill inbox. Manual entries are stored in the `transactions` table with `source='manual'` and participate in all bill window queries, categorization, and shifts. The form accepts day/month/year, credit or debit direction, and optional installment metadata (`installmentNumber` / `totalInstallments`) so manual entries surface in the split summary's installments section like Pluggy-sourced parceladas. They can be edited/deleted via the `⋯` menu and are marked with an orange "manual" badge.

Bill splitting: transactions can be marked as shared with a partner — "½" (50/50) or "→dela" (partner owes 100%). Categorized transactions without a split row are implicitly "meu". Per-row actions in the ⋯ menu plus bulk split in the selection bar. Both Dashboard and Overview render the unified `SplitSection` component: dynamic columns for ½, dela, and meu with totals, category breakdowns, and installments (the installments list shows the sum of selected parcelas at the top). Data lives in a `transaction_splits` join table for explicit shared rows only (`'half'` / `'theirs'`) and survives re-syncs.

Responsive: the layout is mobile-aware. The CashFlow ledger collapses to a compact column set on small screens; BillHeader's action buttons sit inline with the bill-cycle nav and "gerenciar regras" / "gerenciar bancos" links hide below `md`; SplitSection collapses to a single column.

56 tests covering `billWindow` (including `findOffsetForDueMonth`), `merchantSlug`, and `applyLearnedRules`.

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

**Commit as you go, not at the end.** For any task with more than ~2 logical steps, commit at each natural checkpoint where the code is coherent, typechecks, and represents a standalone unit of progress. Each commit: one logical change, descriptive body explaining *why*, `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer. Update `CHANGELOG.md` on relevant commits. Run `npm run typecheck` before committing.

**Trust the data, not the docs.** Pluggy's official docs and SDK README have been wrong multiple times for this project: `fetchAccounts` signature, `fetchBills`/`fetchCreditCardBills` naming, the sign convention of `Transaction.amount`. Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`, and when in doubt about data shape, query the actual SQLite cache: `sqlite3 packages/api/data/finance.sqlite "SELECT ..."`.

**Diagnose before changing code.** When the user reports "something isn't working", investigate the actual cause before proposing fixes. Ask what they see in the browser console / Network tab and which endpoint response is surprising. Don't jump to plausible-sounding hypotheses.

**Tailwind v4 "canonical classes" warnings are noise.** The IDE flags hundreds of `text-[color:var(--color-ink)]` → `text-(--color-ink)` suggestions. They are purely stylistic and pervasive across the whole codebase; don't treat them as errors and don't pause work to chase them. Real type errors come from `tsc`, not the editor's canonical-class linter.

**CLAUDE.md is a present-tense state doc.** No history, no anecdotes. When a feature lands, update the relevant section or delete what it invalidates. History goes in a future CHANGELOG, not here.

## Architecture

### Data model

Four independent domains in SQLite, deliberately not merged:

1. **Pluggy credit cache** (`items`, `accounts`, `transactions`, `bills`) — read-through cache of CREDIT-account data. `accounts` is populated during sync from `fetchAccounts(itemId, 'CREDIT')` and `fetchAccounts(itemId, 'BANK')` (same table for both subtypes). BANK accounts carry `balance` and `subtype` (e.g. `CHECKING_ACCOUNT`). `raw_json` on each row keeps the full payload so new fields can surface later without a backfill. The `transactions.source` column distinguishes `'pluggy'` (synced) from `'manual'` (user-created). Manual transactions persist across re-syncs; Pluggy-sourced rows can be wiped and re-synced without losing user work.
2. **Pluggy bank cache** (`bank_transactions`, `bank_transaction_description_overrides`, `bank_bill_payment_tags`, `bank_transaction_hidden`, `balance_snapshots`) — BANK-account transactions live in their own table to isolate CashFlow concerns from credit-card sync. Sister tables hold description overrides, the bill-payment tag (clickable source column that links a bank outflow to a credit-card bill), and a hide flag for visually-duplicate rows the bank reported twice. `balance_snapshots` stores periodic account balances used to anchor the CashFlow running balance.
3. **User configuration** (`account_settings`, `card_groups`, `card_group_members`) — per-account closing/due days (Pluggy does not expose these), plus the user's optional grouping of physical cards by `card_last4` scoped per account. Card groups are used only to filter the transaction list (chips above the inbox); they no longer drive per-card bill totals. One card belongs to at most one group (composite primary key enforces exclusivity). Legacy `card_settings` (per-item) table remains for backward compat but the frontend writes to `account_settings`.
4. **User work** (`user_categories`, `transaction_categories`, `category_rules`, `transaction_bill_overrides`, `transaction_description_overrides`, `transaction_splits`, `transaction_sync_conflicts`) — categorization, learned rules, manual bill-cycle shifts, description overrides, bill splitting, and recycled-ID sync audits. These are **separate join tables**, not columns on `transactions`, so a Pluggy re-sync never wipes them. `transaction_splits` only stores explicit shared markings (`'half'` = 50/50, `'theirs'` = partner owes 100%); categorized transactions without a split row are implicitly mine in split summaries.
5. **Cash flow projections** (`manual_entries`) — recurring entries (salary, rent, etc.) with `day_of_month` for placement. Each entry is scoped to a specific `month` (`YYYY-MM`) so each month edits independently — duplicate-to-next-month is the workflow for propagating recurring items. `sort_key` (also on `bank_transactions`) enables drag-and-drop reordering within a day group; NULL means "natural order".

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

The full endpoint catalog (auth, items, sync, bills, transactions, cash flow) lives in [docs/api.md](docs/api.md). The frontend mounts `<PluggyConnect>` by rendering it (no `isOpen` prop); `onSuccess({ item })` returns the item id which is then POSTed to `/items`.

### Frontend design language

Editorial / financial-press. Light warm-paper background (`#fbf8f4`), warm near-black ink, single burnt-orange accent (`#c2410c`). No drop-shadow cards, no gradients, no rounded-xl anything. Aesthetic is "printed broadsheet", not "SaaS dashboard".

Type system:

- **Fraunces** (variable serif) — dominates the page. Used for every heading and for the bill headline (96px / 72px narrow) and account-card totals (40px).
- **JetBrains Mono** — currency and dates. `font-variant-numeric: tabular-nums` set project-wide for column alignment.
- **Inter** — small UI metadata only (labels, tiny hints).

Decoration: fixed CSS-only paper-grain noise overlay, fixed vertical margin rule at `left: 48px`, focus rings in the accent color, muted scrollbars. Motion is used sparingly — entrance fades for screens, slide-up for the bulk action bar and toast, card fade-in. No micro-animations scattered.

The app has three primary screens in a drill-down hierarchy plus a Login gate: **Login** → **CashFlow** → **Overview** → **Dashboard** (and **Onboarding** when no bank is linked). **CashFlow** (`CashFlow.tsx`) is the top-level landing page: multi-month financial ledger with columns (origem | dia | descrição | débito | crédito | saldo), bank transactions for past days, manual entries + credit card bill outflows for future days, running balance with one global realized/projected boundary, inline editing of descriptions/amounts/dates, drag-and-drop reordering within a day, ghost row for adding new entries. Clicking a credit card bill drills into Overview. **Overview** (`Overview.tsx`): "← voltar" to CashFlow → ←/→ month navigation (auto-advances when next month has activity) → grand total with delta → aggregated category breakdown → aggregated `SplitSection` → grid of account cards plus a `ManageBankButton` dropdown (add/remove banks). Clicking an account card drills into Dashboard. **Dashboard** (`Dashboard.tsx`): "← voltar" to Overview → account tabs (if multiple) → `BillHeader` (bill-cycle arrows, giant total, delta, closing/due dates, inline regras/sincronizar actions) → `SplitSection` (partner debt breakdown) → `CardGroupFilterBar` (chips to filter the list by card group + "gerenciar" link, hidden below `md`) → `CategoryTabs` → `TransactionInbox`. App.tsx manages drill-down state: `overviewMonth` (year/month from CashFlow → Overview) and `drillDown` (itemId/accountId/offset from Overview → Dashboard), gated by the `useQuery(['auth'])` result.

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
- **Pluggy data shape quirks** (sign convention, `Transaction.date` as `Date`, etc.) live in [docs/pluggy.md](docs/pluggy.md).

## Pluggy gotchas

SDK quirks (signature surprises, sign conventions, cardNumber shapes, "pagamento recebido" reconciliation rows, installment posting dates) are catalogued in [docs/pluggy.md](docs/pluggy.md). Read it before writing integration code — Pluggy's official docs have been wrong about this project's connectors multiple times.

## Out of scope

- Multi-user auth, hosted multi-tenant deployment (single-user password gate is the only auth)
- Docker, Fly, Vercel — Railway/Nixpacks is the only deployment target checked in
- Graphs, charts, CSV export, full-text search
- Category hierarchy (categories are flat)
- Manual color picking for categories or card groups (system assigns from a curated palette)
