# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Test suite**: `node --test` with `tsx` loader — 28 tests covering `billWindow` (open/previous/next window math, year boundaries, day clamping, contiguity) and `merchantSlug` (prefix stripping, star/dash splitting, location removal, fuzzy collapsing, edge cases). Zero new dependencies.

### Changed

- Dev servers (Vite + Express) now bind to `0.0.0.0`, allowing access from other devices on the local network.

### Fixed

- `PARCxx/yy` installment suffix is now stripped in the API layer (`shapeRow`) instead of only in the frontend's installment render. All consumers (dashboard, inbox, future exports) get clean descriptions.

## [0.1.0] - 2026-04-09

First minimally functional version. End-to-end flow from connecting a card to categorizing transactions with learned rules and seeing per-group breakdowns.

### Added

- **Pluggy integration**: connect a credit card via the Pluggy Connect widget (Meu Pluggy supported), sync transactions and closed bills, cache everything locally in SQLite.
- **Open-bill calculation**: reconstructs the currently open bill window from user-configured `closing_day` and `due_day`, since Pluggy does not expose open bills.
- **User-defined categories**: flat list with auto-assigned colors from a curated palette. Create inline from the category picker by typing a name that doesn't exist yet.
- **Learning loop**: every manual categorization trains a `merchant_slug → category` rule. Future transactions with the same slug are auto-categorized on sync, tagged "auto". Two user corrections disable a bad rule automatically.
- **Bulk categorization**: select multiple transactions and assign a category in one action. Each assignment feeds the learning engine individually.
- **Clear category**: remove a category assignment from a transaction, returning it to "uncategorized" (and excluding it from bill totals).
- **Categorized-only totals**: bill totals sum only categorized transactions. Uncategorized rows (noise like "pagamento de fatura") stay visible but don't count. No "ignore" flag needed — absence of category is the exclusion.
- **Card groups**: group physical cards (titular, adicional, virtual) by their last 4 digits. Each group gets its own card on the dashboard with independent totals, category breakdowns, and installment listings.
- **Per-group category breakdown**: each card shows categories ordered by total with proportional 2px bars. Capped at 4 with a "+ N mais" / "− recolher" toggle.
- **Per-group installments**: each card lists parceladas landing in the current bill, with the `PARCxx/yy` suffix stripped from the description at render time. Same 4-row cap with expand.
- **Bill-cycle shifts**: move individual transactions to the previous or next bill cycle when the purchase date doesn't match the actual billing date. Shifted rows disappear from the current list; a 6-second undo toast provides recovery.
- **Dashboard layout**: editorial headline (Fraunces 96px) with the overall total, per-group card grid below, category tabs that filter the transaction list, and the categorization inbox with bulk selection bar.
- **Category tabs**: horizontal row derived from the selected card's breakdown. Filters the transaction inbox client-side.
- **Card groups management modal**: create, rename, delete groups; assign cards to groups via dropdown.
- **Card last 4 digits**: extracted from `creditCardMetadata.cardNumber`, normalized, shown inline on each transaction row.
- **Toast system**: global snackbar with optional undo action, 6-second auto-dismiss, hover pauses countdown.
- **Row actions menu**: trailing "⋯" on each transaction row, portal-positioned, hosts the bill-shift commands.
- **Onboarding screen**: editorial landing page with one-click Pluggy Connect widget integration.
- **Card settings setup**: one-time form for `closing_day`, `due_day`, and optional display name.
- **Design system**: light warm-paper theme (`#fbf8f4`), burnt-orange accent (`#c2410c`), Fraunces / JetBrains Mono / Inter type trio, fixed paper-grain overlay, vertical margin rule.
