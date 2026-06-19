# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, small-group** credit card spending manager backed by [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). The value is not just viewing transactions — it's **categorizing them** with user-defined categories that the system learns to auto-apply, seeing the **currently open bill** with category breakdown and installment detail, and splitting shared spend with a partner. One Pluggy account in `packages/api/.env` powers everyone; each user gets an isolated SQLite file under `DATABASE_DIR/<username>.sqlite`, and credentials are declared as `USER_<NAME>_PASSWORD` env vars (no signup flow, the operator manages users by editing env).

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
- **Auth.** Per-user passwords via `USER_<NAME>_PASSWORD` env vars; cookie session carries the username (HMAC-signed with `SESSION_SECRET`). When no `USER_*_PASSWORD` is set, the API falls back to an open "default" user for local dev.
- **Per-user SQLite.** Each authenticated user has their own database file at `DATABASE_DIR/<username>.sqlite`, opened on first request and cached per-process. Migrations run automatically on first open. Routes access the DB via `req.db` (injected by `authMiddleware`); never import a `db` singleton.
- **Deployment.** Railway/Nixpacks config checked in. Production Express serves the SPA from `packages/web/dist` on the same origin and strips the `/api/` prefix. `DATABASE_DIR` required (no default) — point at a persistent volume.
- **Responsive.** Mobile-aware layout (compact CashFlow columns, inline BillHeader actions, single-column SplitSection).
- **Tests.** 61 tests covering `billWindow` (including `findOffsetForDueMonth`), `merchantSlug`, `applyLearnedRules`, `pruneRealizedManualEntries`.

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

SQLite, five domains deliberately not merged so each can evolve independently:

1. **Pluggy credit cache** — `items`, `accounts`, `transactions`, `bills`.
2. **Pluggy bank cache** — `bank_transactions` (+ description overrides, bill-payment tags, hide flag) and `balance_snapshots`.
3. **User configuration** — `account_settings` (closing/due days, Pluggy doesn't expose them), `card_groups` (+ `card_group_members`, scoped per account).
4. **User work** — `transaction_categories`, `category_rules`, `transaction_bill_overrides`, `transaction_description_overrides`, `transaction_splits`, `transaction_sync_conflicts`. **Separate join tables keyed on the local UUID**, so re-syncs never wipe them.
5. **Cash flow projections** — `manual_entries` (per-month recurring rows with `day_of_month`, `sort_key` for drag-order).

Schema definitions, sister-table relationships, and the cascade-delete trap (never `INSERT OR REPLACE` on cache tables) are documented in [docs/schema.md](docs/schema.md). The `CREATE TABLE` source of truth is [packages/api/src/db/index.ts](packages/api/src/db/index.ts) — append-only `addColumnIfMissing()` migrations, idempotent via `PRAGMA table_info`.

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
- **Never use `INSERT OR REPLACE` on Pluggy cache tables.** It internally DELETEs then INSERTs and triggers `ON DELETE CASCADE` on user-work join tables, silently wiping categories/splits/shifts. Always `INSERT ... ON CONFLICT(id) DO UPDATE SET ...`. Full explanation in [docs/schema.md](docs/schema.md).
- **Pluggy data shape quirks** (sign convention, `Transaction.date` as `Date`, etc.) live in [docs/pluggy.md](docs/pluggy.md).

## Pluggy gotchas

SDK quirks (signature surprises, sign conventions, cardNumber shapes, "pagamento recebido" reconciliation rows, installment posting dates) are catalogued in [docs/pluggy.md](docs/pluggy.md). Read it before writing integration code — Pluggy's official docs have been wrong about this project's connectors multiple times.
