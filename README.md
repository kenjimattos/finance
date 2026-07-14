# Finance

A self-hosted credit-card spending manager for a small group (you and a partner), backed by [Pluggy](https://pluggy.ai), the Brazilian Open Finance aggregator. The UI is in Brazilian Portuguese; it renders in an editorial, financial-press style — warm paper, one burnt-orange accent, Fraunces headlines, JetBrains Mono currency.

> **Live demo:** [finance-demo-production.up.railway.app](https://finance-demo-production.up.railway.app/) — log in with username `demo` and password `demo`. The account is fully interactive over ~5 months of synthetic data; it resets periodically.

The point is not just *viewing* transactions — banks already do that. It's the workflow around them:

- **Categorize with your own categories**, and the system learns: categorizing "IFOOD *RESTAURANTE X" once auto-applies the category to every future iFood charge (merchant-slug rules with manual override).
- **See the currently open bill** — total, delta vs the previous cycle, category breakdown, installment detail. Pluggy never returns open bills, so bill windows are computed locally from each card's closing/due day, with per-transaction nudging (`bill_shift`) for charges that post into a neighboring cycle.
- **Split shared spend** — mark rows ½ or "dela"; the bill view totals what each person owes, per category, including installments.
- **Project cash flow** — a day-by-day checking-account ledger: real bank transactions for the past, recurring manual entries plus upcoming credit-card bills for the future, grounded on a user-confirmed balance anchor instead of Pluggy's (unreliable) live balance field.
- **Import faturas from screenshots** — when Pluggy misses transactions, upload screenshots of the issuer's app and Claude vision extracts them into reviewable rows (optional, gated on `ANTHROPIC_API_KEY`).

Multiple banks, multiple users: one Pluggy account powers everyone; each user is an env var (`USER_<NAME>_PASSWORD`) and gets an isolated SQLite file. No signup flow — the operator manages users by editing env.

## Demo account

A hosted instance is available at [finance-demo-production.up.railway.app](https://finance-demo-production.up.railway.app/) (username `demo`, password `demo`). To run your own, the repo ships a sandboxed demo login for showcasing the app without exposing real data:

```bash
npm run -w @finance/api seed:demo
```

generates ~5 months of synthetic data (two banks, categorized history with learned rules, installments, splits, checking account with salary/rent/bill payments), always relative to the run date. Set `USER_DEMO_PASSWORD` and log in as `demo`: everything that touches only the demo's own database works — categorizing, splitting, manual entries — while anything that escapes it (Pluggy connect/sync, screenshot import, admin) is blocked by the API and hidden in the UI. Re-run the seed to reset whatever visitors changed.

## Stack

npm-workspaces monorepo, TypeScript end to end:

| Package | What | Built with |
| --- | --- | --- |
| [`packages/api`](packages/api/) | REST API, Pluggy sync, SQLite cache | Express, `pluggy-sdk`, `better-sqlite3`, Zod, `@anthropic-ai/sdk` |
| [`packages/web`](packages/web/) | SPA (Login → CashFlow → Overview → Dashboard) | React, Vite, Tailwind v4, TanStack Query, Motion |

## Engineering notes

The parts that took actual thought, documented in [docs/](docs/):

- **Transaction identity is local** ([docs/sync.md](docs/sync.md)). Pluggy recycles transaction IDs, reposts PENDING rows with new dates, and re-issues everything on reconnection. Rows are keyed by a locally minted UUID; sync dedupes by a SHA-256 of `date + amount + merchant_slug` (deliberately excluding `account_id`, so identity survives reconnects), with an explicit state machine for recycled IDs and PENDING→POSTED transitions.
- **User work survives re-sync** ([docs/schema.md](docs/schema.md)). Categories, splits, shifts, and description overrides live in join tables keyed on the local UUID — a full re-sync never wipes them. Corollary: `INSERT OR REPLACE` is banned on cache tables (it DELETEs first and cascades through the user-work tables).
- **Bill windows are computed, not fetched** ([docs/sync.md](docs/sync.md)). All date math on `yyyy-mm-dd` UTC strings; ←/→ navigation across cycles is an `offset` over the same window function.
- **The data contradicts the docs** ([docs/pluggy.md](docs/pluggy.md)). A catalog of places where Pluggy's documentation was wrong for these connectors — sign conventions, method names, balance oscillation — and what the API actually returns.
- **Per-user isolation is a file** — each username maps to its own SQLite database, opened on first request, migrated automatically, injected into routes as `req.db`.

## Running it

Requirements: Node 20, free [Pluggy dashboard](https://dashboard.pluggy.ai) credentials.

```bash
npm install
cp packages/api/.env.example packages/api/.env   # fill in Pluggy creds
npm run dev                                      # api on :3333, web on :5174
```

Both servers bind to `0.0.0.0`, so other devices on your network can use the app via the host's IP. Vite proxies `/api/*` to the backend during dev.

Other commands:

```bash
npm run typecheck              # both workspaces
npm test                       # api tests (node --test + tsx)
npm run build                  # api → dist, web → dist
npm run -w @finance/api seed:demo   # (re)generate the demo dataset
```

### Configuration

All env is read and validated in [`config.ts`](packages/api/src/config.ts); the app fails fast on missing/invalid values. See [`.env.example`](packages/api/.env.example) for the full annotated list — the essentials:

| Var | Required | Purpose |
| --- | --- | --- |
| `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | yes | Pluggy API credentials |
| `DATABASE_DIR` | yes | Directory for the per-user SQLite files |
| `SESSION_SECRET` | prod | HMAC key for the session cookie |
| `USER_<NAME>_PASSWORD` | — | Declares a user; none set → open single-user dev mode |
| `USER_<NAME>_PARTNER` | — | Links two users for shared-card views |
| `DEMO_USERS` | — | Demo usernames (default `demo`) |
| `ANTHROPIC_API_KEY` | — | Enables screenshot fatura import |

### Deployment

Railway config ([`railway.toml`](railway.toml) + [`nixpacks.toml`](nixpacks.toml)) is checked in. In production the API serves the built SPA from the same origin and strips the `/api/` prefix; point `DATABASE_DIR` at a persistent volume.

## License

Personal project; no license granted. Feel free to read, learn from, and reference the code.
