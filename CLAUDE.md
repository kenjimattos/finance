# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, single-user** system for managing personal credit card spending via [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). The product is **not** just a transaction viewer — those exist already. The core value is:

1. **Open-bill visibility** — a prominent display of the currently open bill total, its closing/due dates, and delta vs the previous bill.
2. **User-owned categorization** — the user defines their own flat list of categories and classifies transactions with them. The system learns from these assignments and auto-categorizes future transactions silently.

**Planned (not yet built):** a cash-flow projection screen that combines closed-bill due dates with manually-entered entries (salary, rent, etc.) to give a forward view of the user's checking account balance. This future feature drives several "keep data separate, don't abstract early" decisions today.

Open-source friendly: each user runs their own copy with their own Pluggy credentials in `packages/api/.env`. There is no multi-tenant auth layer and adding one is **not** a goal.

## Repository layout

npm workspaces monorepo:

- [packages/api](packages/api/) — Express + TypeScript + `pluggy-sdk` + `better-sqlite3`. All Pluggy communication and the SQLite cache live here.
- [packages/web](packages/web/) — Vite + React + TypeScript + Tailwind v4 + TanStack Query + Motion + `react-pluggy-connect`. Single-screen UI.

No shared package exists yet — types are defined at the API boundary in [packages/web/src/lib/api.ts](packages/web/src/lib/api.ts). Extract a shared package only when a second consumer appears; don't design for hypothetical reuse.

## Common commands

Run from the repo root:

```bash
npm install                           # install all workspace deps
npm run dev                           # api (localhost:3333) + web (localhost:5173) in parallel
npm run dev:api                       # api only
npm run dev:web                       # web only
npm run build                         # tsc → api/dist, then vite build → web/dist
npm run typecheck                     # typecheck both workspaces
npm run -w @finance/api typecheck     # just the api
npm run -w @finance/web typecheck     # just the web
```

Vite proxies `/api/*` → `http://localhost:3333` during dev so the frontend has no CORS dance. There are no tests yet. Before adding a test runner, ask the user which one — don't default to Jest.

## Working style in this repo

**Commit as you go, not at the end.** For any task with more than ~2 logical steps, commit at each natural checkpoint where the code is coherent, typechecks, and represents a standalone unit of progress. Don't batch everything into a single "big bang" commit at the end of a session — the user has explicitly asked for granular incremental commits so progress can be reviewed, reverted, or bisected. Each commit should follow the existing style: one logical change per commit, descriptive body explaining *why*, Co-Authored-By trailer. Run `npm run typecheck` before committing.

**Verify against real types, not docs.** Pluggy's official docs have been wrong at least twice on this project (`fetchAccounts` options shape, `fetchBills` method name). Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`. Trust the types over the README.

## Architecture

### Data model — why it's split the way it is

Three independent data domains live in SQLite, deliberately not merged:

1. **Pluggy cache** (`items`, `transactions`, `bills`) — a read-through cache of what Pluggy returns. `raw_json` on each row keeps the full payload so new Pluggy fields can be surfaced later without a backfill. Can be wiped and re-synced without losing user work.
2. **User categorization** (`user_categories`, `transaction_categories`, `category_rules`) — the user's own work. Never touched by a Pluggy sync. `transaction_categories` is a **separate** join table (not a column on `transactions`) precisely so re-syncing is non-destructive.
3. **User configuration** (`card_settings`) — per-card `closing_day` + `due_day`. These are not derivable from Pluggy at all (see below), so the user fills them in once and the values drive every bill-window calculation downstream.

When the cash-flow feature arrives, it will add its own tables (`manual_entries`, likely) rather than forcing itself into the existing ones. Resist the urge to introduce a `cash_flow_events` abstraction now — we don't know enough about it yet.

### The open bill problem (critical)

**Pluggy's `/bills` endpoint does NOT return open bills.** The official docs say so explicitly: "Open bills are not returned until the bill is closed or overdue." Transactions in the still-open cycle have `creditCardMetadata.billId === null` until the bill closes, and some may not even be returned yet.

Consequence: **the open bill total is computed by us, not fetched.** The flow is:

1. The user configures `closing_day` and `due_day` once via `PUT /card-settings/:itemId`.
2. [billWindow.ts](packages/api/src/services/billWindow.ts) reconstructs the window: `(lastClosingDate, nextClosingDate]` and the `nextDueDate`. All date math uses `yyyy-mm-dd` strings (UTC-safe) — do NOT use local `Date` arithmetic here, it breaks around DST.
3. `GET /bills/current` sums transactions in that window from the cache and returns `{ total, previousTotal, delta, ... }`.
4. `GET /bills` lists the *closed* bills cached from Pluggy (informational, not used by the main screen).

If `card_settings` is missing for an item, `/bills/current` returns **412 Precondition Failed** with a clear message — the frontend's Dashboard uses that signal to show the setup form.

### The learning loop (core feature)

Every manual categorization feeds a rules engine. Written in [categorize.ts](packages/api/src/routes/categorize.ts) + [merchantSlug.ts](packages/api/src/services/merchantSlug.ts):

1. User assigns category Y to a transaction with description "IFOOD *RESTAURANTE XYZ".
2. `extractMerchantSlug()` normalizes the description to "IFOOD" (strips processor prefixes, cuts at `*`, drops location tokens, takes the first few tokens). Intentionally fuzzy so "IFOOD *A" and "IFOOD *B" collapse to the same slug.
3. A row is upserted into `category_rules (merchant_slug, user_category_id)` with `hit_count = 1`, or `hit_count += 1` if it already exists.
4. On the next sync, [transactions.ts](packages/api/src/routes/transactions.ts) → `applyLearnedRules(itemId)` walks every uncategorized transaction, derives its slug, and assigns the matching category silently with `assigned_by = 'learned'`.
5. If the user **corrects** a learned assignment (replaces it with a different category), `override_count` is bumped on the offending rule. At `override_count >= 2` the rule flips `disabled = 1` and stops firing — the system un-learns bad guesses.

Deliberate design choices:

- **No regex, no priorities, no UI for rule management.** Simplicity wins. If the learning loop turns out to be too dumb for real usage, revisit then.
- **The frontend never mentions rules directly.** Users see their transactions get categorized; they don't see "a rule was created". The only surfaced signal is a small italic "auto" label next to auto-applied assignments in the UI, so they can tell apart and correct.
- **Bulk categorize uses the same engine.** `POST /transactions/bulk-categorize` applies one category to many transaction IDs, each of which feeds the rule for its own slug. Selecting 15 Uber rows once and picking "Transporte" trains 15 hits on the UBER → Transporte rule.

### Request flow (onboarding → categorization)

1. `POST /connect-token` → short-lived JWT for the Pluggy Connect widget. **Never cache this** — generate one per widget session.
2. Frontend renders `<PluggyConnect>` from `react-pluggy-connect`. Rendering it mounts the modal; unmounting closes it. There is no `isOpen` prop. On success it calls `onSuccess({ item })` with an `Item` whose `id` is the `itemId` you'll use for everything else.
3. `POST /items { itemId }` — backend validates via `pluggy.fetchItem()` and persists to `items`. Invalidates the frontend's items query.
4. `GET /card-settings/:itemId` returns 404 if not configured → frontend shows `CardSettingsSetup` form.
5. `PUT /card-settings/:itemId { closingDay, dueDay, displayName? }` — one-time config.
6. `POST /transactions/sync?itemId=...` — syncs bills and transactions from Pluggy, then runs `applyLearnedRules`. Returns `{ transactions, bills }` counts.
7. `GET /bills/current?itemId=...` + `GET /transactions?itemId=...&from=...&to=...` — powers the Dashboard.
8. `PUT /transactions/:id/category { categoryId }` or `POST /transactions/bulk-categorize { transactionIds, categoryId }` — user's main interaction with the app.

### Frontend design language

Editorial / financial-press: light warm-paper background (`#fbf8f4`), warm near-black ink, a single burnt-orange accent (`#c2410c`). The type system is a trio:

- **Fraunces** (variable serif, opsz 9–144) — dominates the page. Used for every heading and for the giant bill total (136px).
- **JetBrains Mono** — all currency and dates. `font-variant-numeric: tabular-nums` is set project-wide so columns align cleanly.
- **Inter** — used **sparingly**, only for small UI metadata (labels, tiny hints). Most of the visual hierarchy is Fraunces.

Decorative touches: a fixed CSS-only paper-grain noise overlay, a fixed vertical margin rule at `left: 48px`, custom focus rings in the accent color, muted scrollbars. No drop-shadow cards, no gradients, no rounded-xl anything. The aesthetic is "printed broadsheet", not "SaaS dashboard".

Motion is used in exactly three places: onboarding fade-in, the bill total re-animating when its value changes, and the bulk action bar sliding up from the bottom. Don't scatter micro-animations.

### Config boundary

[packages/api/src/config.ts](packages/api/src/config.ts) is the single place that reads `process.env`, validated with Zod. Everything else imports `config`. Don't scatter `process.env.X` access across the codebase — this is the boundary. Missing/invalid env fails fast at boot.

## Conventions

- **ESM only.** `"type": "module"` in both packages. In the **api** package, relative imports must end in `.js` (e.g. `import { config } from './config.js'`) because NodeNext resolution needs the runtime extension. The **web** package uses Vite's bundler resolution so extensions are optional there.
- **Zod at the edges.** Validate request bodies and query strings with Zod in the route file; the global error handler in [packages/api/src/index.ts](packages/api/src/index.ts) turns `ZodError` into a 400. Don't catch validation errors locally.
- **Routes are thin.** Pure, testable logic (merchant slugging, bill-window math, color picking) lives under [packages/api/src/services/](packages/api/src/services/). Route files contain validation, SQL, and orchestration.
- **SQLite access is synchronous.** `better-sqlite3` is intentionally sync — no `await db.something()`. Wrap multi-row writes in `db.transaction(...)` for speed and atomicity.
- **`Transaction.date` from Pluggy is a `Date` object**, not a string. Normalize to `yyyy-mm-dd` at the storage boundary via `toYmd()` in [transactions.ts](packages/api/src/routes/transactions.ts). Every downstream date comparison assumes `yyyy-mm-dd` strings.

## Pluggy gotchas worth remembering

- `fetchAccounts(itemId, 'CREDIT')` — positional second arg, not an options object. The README shows the options-object form but TypeScript rejects it.
- The bills method is `fetchCreditCardBills(accountId, options?)`, **not** `fetchBills`.
- `fetchCreditCardBills` only returns **closed** bills. There is no `status` field; there is no "open bill" record. See "The open bill problem" above.
- `amount` on a transaction is **positive for CREDIT (inflow) and negative for DEBIT (outflow)** — for a credit card, most purchases come through as negative. The bill total we show is the inverse ("how much you owe").
- `creditCardMetadata.billId` is the link between a transaction and its closed bill. It is only populated *after* the bill closes.
- `creditCardMetadata.installmentNumber` / `totalInstallments` matter for Brazilian cards and already have columns in the schema.
- Connect tokens from `createConnectToken()` are short-lived (~20 min) — generate one per widget session, don't cache.
- Webhooks require HTTPS; localhost is not accepted. For local dev, skip webhooks and rely on manual `POST /transactions/sync` calls.

## Out of scope (do not add without asking)

- Multi-user auth / user accounts / hosted multi-tenant deployment
- Docker, Fly, Vercel, or any deployment configs — user runs locally
- Non-credit account types (checking accounts etc.). **The cash-flow feature will involve these but is a deliberate future step** — the request for it should come from the user explicitly, and will need its own schema design discussion.
- Graphs, charts, CSV export, full-text search — all explicitly deprioritized in V1 to keep focus on categorization ergonomics
- Category hierarchy (categories are flat; this was a conscious choice)
- Manual color picking for categories (the system assigns from a curated palette)
