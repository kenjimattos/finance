# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, single-user** credit card spending manager backed by [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). The value is not just viewing transactions — it's **categorizing them** with user-defined categories that the system learns to auto-apply, and seeing the **currently open bill** broken down per physical card group. Each user runs their own copy with their own Pluggy credentials in `packages/api/.env`; there is no multi-tenant auth and adding one is not a goal.

## Current state

Functional end-to-end: connect card via `react-pluggy-connect` → configure `closing_day` / `due_day` once → sync bills and transactions from Pluggy → categorize transactions (with learning, bulk, and undo) → group physical cards (titular, adicional, virtual…) → see per-group cards with category breakdowns and installment sub-sections → manually shift individual transactions to a neighboring bill cycle when the purchase date lies about when the charge actually lands.

No tests yet. Cash-flow projection (checking accounts, manual entries, forward view) is a deliberate future feature and not yet built.

## Repository layout

npm workspaces monorepo:

- [packages/api](packages/api/) — Express + TypeScript + `pluggy-sdk` + `better-sqlite3`. All Pluggy communication and the SQLite cache.
- [packages/web](packages/web/) — Vite + React + TypeScript + Tailwind v4 + TanStack Query + Motion + `react-pluggy-connect`. Single-screen UI.

Frontend-facing types live in [packages/web/src/lib/api.ts](packages/web/src/lib/api.ts) and are redeclared there to mirror the backend response shape. No shared package; extract one only when a second consumer appears.

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
npm test                              # run api tests (node --test + tsx)
npm run -w @finance/api test          # same, explicit workspace
```

Both dev servers bind to `0.0.0.0`, so other devices on the local network can access the app via the host machine's IP (e.g. `http://192.168.1.x:5173`). Vite proxies `/api/*` → `http://localhost:3333` during dev so the frontend has no CORS dance. Tests use `node --test` with `tsx` as the ESM loader — no extra dependencies. Test files live next to the modules they cover (`*.test.ts`).

## Working style in this repo

**Commit as you go, not at the end.** For any task with more than ~2 logical steps, commit at each natural checkpoint where the code is coherent, typechecks, and represents a standalone unit of progress. Each commit: one logical change, descriptive body explaining *why*, `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer. Run `npm run typecheck` before committing.

**Trust the data, not the docs.** Pluggy's official docs and SDK README have been wrong multiple times for this project: `fetchAccounts` signature, `fetchBills`/`fetchCreditCardBills` naming, the sign convention of `Transaction.amount`. Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`, and when in doubt about data shape, query the actual SQLite cache: `sqlite3 packages/api/data/finance.sqlite "SELECT ..."`.

**Diagnose before changing code.** When the user reports "something isn't working", investigate the actual cause before proposing fixes. Ask what they see in the browser console / Network tab and which endpoint response is surprising. Don't jump to plausible-sounding hypotheses.

**Tailwind v4 "canonical classes" warnings are noise.** The IDE flags hundreds of `text-[color:var(--color-ink)]` → `text-(--color-ink)` suggestions. They are purely stylistic and pervasive across the whole codebase; don't treat them as errors and don't pause work to chase them. Real type errors come from `tsc`, not the editor's canonical-class linter.

**CLAUDE.md is a present-tense state doc.** No history, no anecdotes. When a feature lands, update the relevant section or delete what it invalidates. History goes in a future CHANGELOG, not here.

## Architecture

### Data model

Three independent domains in SQLite, deliberately not merged:

1. **Pluggy cache** (`items`, `transactions`, `bills`) — read-through cache of what Pluggy returns. `raw_json` on each row keeps the full payload so new fields can surface later without a backfill. Can be wiped and re-synced without losing user work.
2. **User configuration** (`card_settings`, `card_groups`, `card_group_members`) — per-card closing/due days (Pluggy does not expose these), plus the user's grouping of physical cards by `card_last4`. One card belongs to at most one group (composite primary key enforces exclusivity).
3. **User work** (`user_categories`, `transaction_categories`, `category_rules`, `transaction_bill_overrides`) — categorization, learned rules, and manual bill-cycle shifts. These are **separate join tables**, not columns on `transactions`, so a Pluggy re-sync never wipes them.

Column-level migrations use `addColumnIfMissing()` in [db/index.ts](packages/api/src/db/index.ts) — append-only, idempotent via `PRAGMA table_info`. New tables use `CREATE TABLE IF NOT EXISTS` directly.

When the cash-flow feature arrives, it will add its own tables rather than forcing itself into the existing ones. Resist the urge to introduce a generic `events` abstraction now.

### The open bill problem

**Pluggy's bills endpoint does not return open bills.** Open bills are not returned until closed or overdue; in-cycle transactions have `creditCardMetadata.billId === null`. The open bill window must be reconstructed on our side from the user-configured `closing_day` + `due_day`.

[billWindow.ts](packages/api/src/services/billWindow.ts) computes three adjacent windows: `previous`, `current`, `next`. All date math uses `yyyy-mm-dd` strings via UTC — do not use local `Date` arithmetic here, it breaks around DST.

### Bill-cycle shifts

Merchants sometimes submit transactions days after the purchase date, so a purchase made before the closing day can actually land on the next bill. The user fixes this per-transaction via `transaction_bill_overrides (transaction_id, shift)` where `shift ∈ {-1, +1}`. The SQL for the current bill sums:

- unshifted rows whose date lies in `current`, **plus**
- rows with `shift = +1` whose date lies in `previous` (pushed forward into current), **plus**
- rows with `shift = -1` whose date lies in `next` (pulled back into current)

A shifted row disappears from the current-bill list and appears in the neighboring window. The previous-bill delta is computed with the plain unshifted sum — we deliberately don't chase shifts across two cycles (the comparison is already approximate, and double-shifts are vanishingly rare).

### The categorized-only rule

**Only categorized transactions contribute to bill totals.** Uncategorized rows stay visible in the inbox but do not sum. This means fresh cards start at R$ 0 and grow as the user categorizes — the absence of a category is the exclusion mechanism, replacing any need for an "ignore" flag. It also means the user can leave noise like "pagamento de fatura" uncategorized and it naturally stays out.

The previous-period delta is also categorized-vs-categorized for consistency.

### The learning loop

Every manual categorization feeds a rules engine in [categorize.ts](packages/api/src/routes/categorize.ts) + [merchantSlug.ts](packages/api/src/services/merchantSlug.ts):

1. User assigns category Y to a transaction with description "IFOOD *RESTAURANTE XYZ".
2. `extractMerchantSlug()` normalizes the description to "IFOOD" — strips processor prefixes (`PAG*`, `EC*`, `DL*`), cuts at `*`/`-`, drops trailing location tokens (BR, SAO PAULO…), takes the first few tokens. Intentionally fuzzy so `IFOOD *A` and `IFOOD *B` collapse to the same slug.
3. A row is upserted into `category_rules (merchant_slug, user_category_id)`.
4. On the next sync, `applyLearnedRules(itemId)` in [transactions.ts](packages/api/src/routes/transactions.ts) walks every uncategorized transaction, derives its slug, and applies the rule silently with `assigned_by = 'learned'`.
5. If the user corrects a learned assignment by picking a different category, `override_count` on the offending rule is bumped; at `override_count >= 2` the rule flips to `disabled = 1` and stops firing.

Deliberate choices: no regex, no priorities, no UI for rule management. Bulk categorize feeds the same engine — selecting 15 Uber rows once trains 15 hits on the `UBER → Transporte` rule. The frontend surfaces only a small italic "auto" label next to learned assignments.

### Request flow

1. `POST /connect-token` — short-lived JWT for the Pluggy Connect widget. Never cache; generate per session.
2. Frontend renders `<PluggyConnect>`. Rendering mounts the modal; unmounting closes it (no `isOpen` prop). `onSuccess({ item })` gives the `item.id`.
3. `POST /items { itemId }` — backend validates via `pluggy.fetchItem()` and persists.
4. `GET /card-settings/:itemId` → 404 triggers the setup form in the frontend.
5. `PUT /card-settings/:itemId { closingDay, dueDay, displayName? }` — one-time config.
6. `POST /transactions/sync?itemId=...` — syncs bills and transactions, then runs `applyLearnedRules`.
7. `GET /bills/current/breakdown?itemId=...` — one response with the current window dates, neighbor windows, and a `groups[]` array. First entry (`groupId: null`) is "Todos" and becomes the big headline; subsequent entries are the real card groups and become the grid of cards, each with `categories[]` and `installments[]`.
8. `GET /transactions` — accepts `from`/`to` plus the four neighbor-window params (`previousFrom`, `previousTo`, `nextFrom`, `nextTo`) to run in shift-aware mode, returning a transaction list that matches the card totals exactly.
9. `PUT /transactions/:id/category { categoryId }` / `POST /transactions/bulk-categorize` / `DELETE /transactions/:id/category` — the user's main interaction.
10. `PUT /transactions/:id/bill-shift { shift: -1 | 0 | 1 }` — shift (or restore with 0) a single transaction.

### Frontend design language

Editorial / financial-press. Light warm-paper background (`#fbf8f4`), warm near-black ink, single burnt-orange accent (`#c2410c`). No drop-shadow cards, no gradients, no rounded-xl anything. Aesthetic is "printed broadsheet", not "SaaS dashboard".

Type system:

- **Fraunces** (variable serif) — dominates the page. Used for every heading and for the bill headline (96px / 72px narrow) and per-group totals (44px).
- **JetBrains Mono** — currency and dates. `font-variant-numeric: tabular-nums` set project-wide for column alignment.
- **Inter** — small UI metadata only (labels, tiny hints).

Decoration: fixed CSS-only paper-grain noise overlay, fixed vertical margin rule at `left: 48px`, focus rings in the accent color, muted scrollbars. Motion is used sparingly — entrance fades for screens, slide-up for the bulk action bar and toast, card fade-in. No micro-animations scattered.

The dashboard lays out: big headline → grid of per-group cards → `CategoryTabs` (derived from the selected card's categories) → `TransactionInbox` (with bulk action bar at the bottom when rows are selected). Each card caps categories and installments at 4 with a `+ N mais` / `− recolher` toggle; stop-propagation on those toggles is essential because the card itself is a clickable filter.

### Reusable UI patterns

- **Portal for any overlay that needs to escape row stacking contexts.** Used by `CategoryPicker`, `RowActionsMenu`, `CardGroupsManager`, and `ToastLayer`. Common shape: `createPortal` into `document.body`, `getBoundingClientRect` via `useLayoutEffect` for position, `flip upward / right-align` when near edges, listeners for `mousedown` outside / `scroll` outside (scroll **inside** the overlay is explicitly allowed) / `resize` / `Escape`.
- **`ToastProvider`** in [Toast.tsx](packages/web/src/components/Toast.tsx) exposes `useToast()` with `show({ message, undo?, durationMs? })`. One toast at a time; a new one replaces the previous. Hover pauses the 6s countdown. Used after a shift so the user has a recovery window (no historical bill navigation yet).
- **`RowActionsMenu`** for rare per-row actions. Currently hosts the bill-shift commands on each transaction row. Add more actions here before cluttering the row visually.

### Config boundary

[packages/api/src/config.ts](packages/api/src/config.ts) is the single place that reads `process.env`, validated with Zod. Everything else imports `config`. Missing/invalid env fails fast at boot.

## Conventions

- **ESM only.** `"type": "module"` in both packages. In the **api** package, relative imports must end in `.js` (e.g. `import { config } from './config.js'`) because NodeNext resolution needs the runtime extension. The **web** package uses Vite bundler resolution; extensions are optional.
- **Zod at the edges.** Validate request bodies and query strings with Zod in the route file. The global error handler in [packages/api/src/index.ts](packages/api/src/index.ts) turns `ZodError` into a 400. Don't catch validation errors locally.
- **Routes are thin.** Pure, testable logic (merchant slugging, bill-window math, color picking) lives under [packages/api/src/services/](packages/api/src/services/). Route files contain validation, SQL, and orchestration.
- **SQLite access is synchronous.** `better-sqlite3` is intentionally sync — no `await db.something()`. Wrap multi-row writes in `db.transaction(...)` for speed and atomicity.
- **Key on `t.type`, not on the sign of `t.amount`.** Pluggy's sign convention varies across connectors (Meu Pluggy: DEBIT positive / CREDIT negative). `tx.type === 'DEBIT'` is the stable way to know direction; reserve `SUM(amount)` for totals where the convention has already been verified.
- **`Transaction.date` from Pluggy is a `Date` object**, not a string. Normalize to `yyyy-mm-dd` at the storage boundary via `toYmd()` in [transactions.ts](packages/api/src/routes/transactions.ts). Every downstream date comparison assumes `yyyy-mm-dd` strings.

## Pluggy gotchas

- `fetchAccounts(itemId, 'CREDIT')` — positional second argument, not an options object.
- The bills method is `fetchCreditCardBills(accountId, options?)`, not `fetchBills`. It returns only **closed** bills; there is no `status` field and no "open bill" entity.
- `Transaction.amount` sign convention varies by connector. For Meu Pluggy credit accounts: `DEBIT` (purchases) = positive, `CREDIT` (refunds) = negative. Verify with a SQL query against the cache when in doubt; don't trust the SDK type doc comments.
- `creditCardMetadata.billId` links a transaction to its closed bill, populated only after the bill closes.
- `creditCardMetadata.installmentNumber` / `totalInstallments` are populated for parceladas; these are already columns in the schema and surface in the per-group card breakdown.
- `creditCardMetadata.cardNumber` comes in inconsistent shapes across connectors (`"1234"`, `"****1234"`, `"1234 **** **** 5678"`). Normalized to last-4 via `lastFourDigits()` in [transactions.ts](packages/api/src/routes/transactions.ts).
- Pluggy embeds `PARCxx/yy` directly in `description` for installments (e.g. `MERCADO*MERCADPARC05/10`), which is redundant with the structured `installmentNumber`/`totalInstallments`. Stripped in the API layer (`shapeRow` in transactions.ts) so all consumers get clean descriptions. Not mutated in storage.
- Connect tokens are short-lived (~20 min); generate per widget session.
- Webhooks require HTTPS; localhost is not accepted. Use manual `POST /transactions/sync` for local dev.

## Out of scope

- Multi-user auth, hosted multi-tenant deployment
- Docker, Fly, Vercel, or any deployment configs — user runs locally
- Non-credit account types (checking accounts). Cash-flow is a planned feature but requires its own schema discussion first.
- Graphs, charts, CSV export, full-text search
- Category hierarchy (categories are flat)
- Manual color picking for categories or card groups (system assigns from a curated palette)
