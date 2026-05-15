# Frontend

## Design language

Editorial / financial-press. Light warm-paper background (`#fbf8f4`), warm near-black ink, single burnt-orange accent (`#c2410c`). No drop-shadow cards, no gradients, no rounded-xl anything. Aesthetic is "printed broadsheet", not "SaaS dashboard".

Type system:

- **Fraunces** (variable serif) — dominates the page. Used for every heading and for the bill headline (96px / 72px narrow) and account-card totals (40px).
- **JetBrains Mono** — currency and dates. `font-variant-numeric: tabular-nums` set project-wide for column alignment.
- **Inter** — small UI metadata only (labels, tiny hints).

Decoration: fixed CSS-only paper-grain noise overlay, fixed vertical margin rule at `left: 48px`, focus rings in the accent color, muted scrollbars. Motion is used sparingly — entrance fades for screens, slide-up for the bulk action bar and toast, card fade-in. No micro-animations scattered.

## Screen hierarchy

Login → CashFlow → Overview → Dashboard (plus Onboarding when no bank is linked). App.tsx manages drill-down state: `overviewMonth` (year/month from CashFlow → Overview) and `drillDown` (itemId/accountId/offset from Overview → Dashboard), gated by the `useQuery(['auth'])` result.

**CashFlow** ([CashFlow.tsx](../packages/web/src/screens/CashFlow.tsx)) — top-level landing page. Multi-month financial ledger with columns (origem | dia | descrição | débito | crédito | saldo), bank transactions for past days, manual entries + credit-card bill outflows for future days, running balance with one global realized/projected boundary, inline editing of descriptions/amounts/dates, drag-and-drop reordering within a day, ghost row for adding new entries. Clicking a credit-card bill drills into Overview.

**Overview** ([Overview.tsx](../packages/web/src/screens/Overview.tsx)) — "← voltar" to CashFlow → ←/→ month navigation (auto-advances when the next month has activity) → grand total with delta → aggregated category breakdown → aggregated `SplitSection` → grid of account cards plus a `ManageBankButton` dropdown (add/remove banks). Clicking an account card drills into Dashboard.

**Dashboard** ([Dashboard.tsx](../packages/web/src/screens/Dashboard.tsx)) — "← voltar" to Overview → account tabs (if multiple) → `BillHeader` (bill-cycle arrows, giant total, delta, closing/due dates, inline regras/sincronizar actions) → `SplitSection` (partner debt breakdown) → `CardGroupFilterBar` (chips to filter the list by card group + "gerenciar" link, hidden below `md`) → `CategoryTabs` → `TransactionInbox`.

**Login** ([Login.tsx](../packages/web/src/screens/Login.tsx)) — single password input. Renders only when `APP_PASSWORD` is set and `/auth/me` reports unauthenticated.

**Onboarding** ([Onboarding.tsx](../packages/web/src/screens/Onboarding.tsx)) — shown when the user has zero linked items. Mounts `<PluggyConnect>` directly.

## Responsiveness

Mobile-aware throughout. The CashFlow ledger collapses to a compact column set on small screens (debit/credit columns merge, desktop-only headers hide). BillHeader's action buttons sit inline with the bill-cycle nav and "gerenciar regras" / "gerenciar bancos" links hide below `md`. SplitSection collapses to a single column.

## Reusable UI patterns

- **Portal for any overlay that needs to escape row stacking contexts.** Used by `CategoryPicker`, `RowActionsMenu`, `CardGroupsManager`, and `ToastLayer`. Common shape: `createPortal` into `document.body`, `getBoundingClientRect` via `useLayoutEffect` for position, flip upward / right-align when near edges, listeners for `mousedown` outside / `scroll` outside (scroll **inside** the overlay is explicitly allowed) / `resize` / `Escape`.
- **`ToastProvider`** in [Toast.tsx](../packages/web/src/components/Toast.tsx) exposes `useToast()` with `show({ message, undo?, durationMs? })`. One toast at a time; a new one replaces the previous. Hover pauses the 6s countdown. Used after destructive actions (shifts, deletes) so the user has a recovery window.
- **`RowActionsMenu`** for rare per-row actions. Currently hosts bill-shift, manual-entry edit/delete, and split commands on each transaction row. Add more actions here before cluttering the row visually.
- **`SplitSection`** is the unified component for the "Divisão" panel. Used on both Dashboard (single account) and Overview (aggregated across accounts) — dynamic columns for ½ / dela / meu with totals, category breakdowns, and installments.

## Types

Frontend-facing types live in [packages/web/src/lib/api.ts](../packages/web/src/lib/api.ts) and are redeclared there to mirror the backend response shape. No shared package; extract one only when a second consumer appears.
