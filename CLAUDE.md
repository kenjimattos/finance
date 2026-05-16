# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, single-user** credit card spending manager backed by [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). The value is not just viewing transactions — it's **categorizing them** with user-defined categories that the system learns to auto-apply, seeing the **currently open bill** with category breakdown and installment detail, and splitting shared spend with a partner. Each user runs their own copy with their own Pluggy credentials in `packages/api/.env`; there is no multi-tenant auth and adding one is not a goal.

## Key invariants

- **Transaction identity is local.** `transactions.id` is a UUID we mint; `provider_transaction_id` is Pluggy's. On sync we dedupe by a SHA-256 hash of `date + amount + merchant_slug` (no `account_id`, so it survives reconnections), with explicit handling for recycled IDs, reconnects, and PENDING→POSTED transitions. Full state machine in [docs/sync.md](docs/sync.md).
- **BANK rows live in a separate table** (`bank_transactions` + sister tables). Credit-card sync code must never touch them, and vice versa.
- **Only categorized transactions sum.** Uncategorized rows stay in the inbox but contribute zero to bill totals — absence of category is the exclusion mechanism, replacing any "ignore" flag.
- **Bill windows are computed locally**, not fetched from Pluggy (which never returns open bills). All date math in `yyyy-mm-dd` UTC strings. Per-transaction `bill_shift ∈ {-1, 0, +1}` lets the user nudge rows into a neighbor cycle.
- **Manual user work survives re-sync.** Categories, splits, shifts, description overrides are separate join tables keyed on the local UUID.

Mechanics for the bill engine, shift math, and learning loop live in [docs/sync.md](docs/sync.md).

## Current state

Functional end-to-end. What's shipped:

- **Credit cards.** Connect via `react-pluggy-connect`, per-account `closing_day` / `due_day` config, sync of bills + transactions, categorization (with learning, bulk, undo), optional card-grouping (titular/adicional/virtual…), bill headline with total + delta + category breakdown, per-transaction `bill_shift` to nudge edge-of-cycle rows, ←/→ navigation across cycles.
- **Multi-bank.** Multiple Pluggy items, multiple accounts per item. Overview groups all credit accounts by due-month with ←/→ nav, grand total, aggregated category breakdown, drill-in to each account's Dashboard. Banks added/removed via `ManageBankButton`.
- **Cash flow.** `CashFlow` is the landing page: multi-month ledger anchored on `balance_snapshots`, BANK transactions for past days, manual recurring entries (`manual_entries`, per-month) + credit-card bill outflows for future days, single global realized/projected boundary, drag-and-drop reordering within a day, hide flag for bank-side duplicates, click-to-drill on bill outflows.
- **Manual transactions.** Add/edit/delete rows directly in a bill inbox when Pluggy misses them (`source='manual'`). Supports day/month/year, debit or credit direction, and installment metadata so they surface in the split summary's parceladas list.
- **Bill splitting.** Mark transactions ½ or →dela (otherwise implicitly "meu"). Per-row + bulk. Unified `SplitSection` on both Dashboard and Overview.
- **Auth.** Optional password gate (`APP_PASSWORD` env var) with HTTP-only cookie session. Local dev bypasses when unset.
- **Deployment.** Railway/Nixpacks config checked in. Production Express serves the SPA from `packages/web/dist` on the same origin and strips the `/api/` prefix. `DATABASE_PATH` required (no default) — point at a persistent volume.
- **Responsive.** Mobile-aware layout (compact CashFlow columns, inline BillHeader actions, single-column SplitSection).
- **Tests.** 56 tests covering `billWindow` (including `findOffsetForDueMonth`), `merchantSlug`, `applyLearnedRules`.

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

### Request flow

The full endpoint catalog (auth, items, sync, bills, transactions, cash flow) lives in [docs/api.md](docs/api.md). The frontend mounts `<PluggyConnect>` by rendering it (no `isOpen` prop); `onSuccess({ item })` returns the item id which is then POSTed to `/items`.

### Frontend

Editorial / financial-press aesthetic: warm paper, single burnt-orange accent, Fraunces for headlines + JetBrains Mono for currency, no shadows or gradients. Screen hierarchy is **Login → CashFlow → Overview → Dashboard** (drill-down state lives in `App.tsx`). Mobile-responsive throughout. Reusable patterns: Portal-based overlays (`CategoryPicker`, `RowActionsMenu`, `ToastLayer`), one-toast-at-a-time `ToastProvider`, `RowActionsMenu` for rare per-row actions, `SplitSection` shared between Dashboard and Overview.

Full design language, screen-by-screen layout, and pattern catalog: [docs/frontend.md](docs/frontend.md).

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
