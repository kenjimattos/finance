# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A **self-hosted, single-user** API that fetches the owner's personal credit card transactions via [Pluggy](https://pluggy.ai) (Brazilian Open Finance aggregator). Intended to later feed a Vite+React frontend. Open-source friendly: each user runs their own copy with their own Pluggy credentials in `.env` — there is no multi-tenant auth layer, and adding one is **not** a goal.

## Repository layout

npm workspaces monorepo. Currently only [packages/api](packages/api/) exists; [packages/web](packages/web/) (Vite+React) will be added later. Top-level scripts proxy to `@finance/api` via `-w`.

## Common commands

Run from the repo root:

```bash
npm install                          # install all workspace deps
npm run dev                          # tsx watch — hot reload on src/**
npm run build                        # tsc → packages/api/dist
npm start                            # node dist/index.js (needs build first)
npm run -w @finance/api typecheck    # tsc --noEmit, no build artifacts
```

There are no tests yet. Before adding a test runner, ask the user which one — don't default to Jest.

## Architecture

### Request flow (credit card transactions)

1. Frontend asks backend for a **Connect Token** → `POST /connect-token` returns a short-lived token from `pluggy.createConnectToken()`.
2. Frontend opens the **Pluggy Connect widget** with that token; user picks their bank and authenticates with the issuer. Widget returns an `itemId` to the frontend.
3. Frontend posts `itemId` to `POST /items`. Backend validates it with `pluggy.fetchItem()` and stores it in SQLite — this is the persistent link to that bank connection.
4. Frontend calls `GET /transactions?itemId=...&refresh=true` to sync from Pluggy; subsequent calls without `refresh=true` serve straight from the local SQLite cache.

### Sync model (important)

[src/routes/transactions.ts](packages/api/src/routes/transactions.ts) is the only place that talks to Pluggy for transaction data. The flow:

- `fetchAccounts(itemId, 'CREDIT')` — filters to credit card accounts only. **The second argument is a positional enum string, not an options object.** The `pluggy-sdk` README shows the options-object form but TypeScript rejects it; trust the types.
- For each credit account, `fetchTransactions(accountId, { from, to, pageSize: 500 })` pulls a page at a time. `fetchAllTransactions` exists in the SDK if you ever need full history without pagination bookkeeping.
- Results are upserted via `INSERT OR REPLACE` inside a `db.transaction(...)` — this is the batched path, don't replace it with per-row inserts in a loop.
- Reads always come from SQLite. Pluggy is only hit when `refresh=true` is passed. This is deliberate: Pluggy's free tier has usage limits, and cached reads also make the future frontend snappy.

### Why SQLite + `better-sqlite3`

Synchronous API is intentional — it simplifies the route handlers (no `await` on every query) and `better-sqlite3` is faster than any async alternative for a single-process app. The DB file lives at `data/finance.sqlite` (gitignored). Schema is created idempotently on boot in [src/db/index.ts](packages/api/src/db/index.ts). WAL mode is on.

The `transactions` table keeps the full Pluggy object in `raw_json` so new fields can be surfaced later without a backfill. Structured columns exist only for the fields we actually query on (date ranges, item/account scoping) plus credit-card installment metadata.

### Config boundary

[src/config.ts](packages/api/src/config.ts) is the single place that reads `process.env`, validated with Zod. Everything else imports `config`. Don't scatter `process.env.X` access across the codebase — this is the boundary. Missing/invalid env fails fast at boot.

### Pluggy SDK client

One shared `PluggyClient` instance in [src/services/pluggy.ts](packages/api/src/services/pluggy.ts). The SDK handles its own auth/token refresh internally — don't wrap it in retry logic or token caches.

## Conventions

- **ESM only.** `"type": "module"` in the api package. Relative imports must end in `.js` (TS compiles to ESM; this is how NodeNext resolution works) — e.g. `import { config } from './config.js'` even though the source is `.ts`.
- **Zod at the edges.** Validate request bodies and query strings with Zod in the route file; the global error handler in [src/index.ts](packages/api/src/index.ts) turns `ZodError` into a 400. Don't catch validation errors locally.
- **Routes are thin.** Business logic (e.g. `syncItemTransactions`) lives alongside the route when it's used once. Extract to `src/services/` only when a second caller appears.

## Pluggy gotchas worth remembering

- `fetchAccounts(itemId, 'CREDIT')` — positional second arg, see above.
- `amount` on a transaction is **positive for CREDIT (inflow) and negative for DEBIT (outflow)** — for a credit card, most purchases come through as negative.
- `creditCardMetadata.installmentNumber` / `totalInstallments` are the installment ("parcela") fields that matter for Brazilian cards — they're already columns in the schema.
- Connect tokens from `createConnectToken()` are short-lived — generate one per widget session, don't cache.
- Webhooks require HTTPS; localhost is not accepted. For local dev use ngrok, or just skip webhooks and rely on the `refresh=true` query param.

## Out of scope (do not add without asking)

- Multi-user auth / user accounts
- Hosted deployment configs (Docker, Fly, Vercel) — user runs locally
- Transaction categorization/ML beyond what Pluggy already returns
- Non-credit account types (checking accounts etc.) — scope is **credit cards**
