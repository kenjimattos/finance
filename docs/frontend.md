# Frontend

## Design language

Editorial / financial-press. Light warm-paper background (`#fbf8f4`), warm near-black ink, single burnt-orange accent (`#c2410c`). No drop-shadow cards, no gradients, no rounded-xl anything. Aesthetic is "printed broadsheet", not "SaaS dashboard".

Type system:

- **Fraunces** (variable serif) — dominates the page. Used for every heading and for the bill headline (96px / 72px narrow) and account-card totals (40px).
- **JetBrains Mono** — currency and dates. `font-variant-numeric: tabular-nums` set project-wide for column alignment.
- **Inter** — small UI metadata only (labels, tiny hints).

Decoration: fixed CSS-only paper-grain noise overlay, fixed vertical margin rule at `left: 48px`, focus rings in the accent color, muted scrollbars. Motion is used sparingly — entrance fades for screens, slide-up for the bulk action bar and toast, card fade-in. No micro-animations scattered.

## Screen hierarchy

Login → CashFlow → Overview → Dashboard (plus Onboarding when no bank is linked). App.tsx manages drill-down state: `overviewMonth` (year/month from CashFlow → Overview) and `drillDown` (itemId/accountId/offset from Overview → Dashboard), gated by the `useQuery(keys.auth())` result.

**CashFlow** ([CashFlow.tsx](../packages/web/src/screens/CashFlow.tsx)) — top-level landing page. Multi-month financial ledger with columns (origem | dia | descrição | débito | crédito | saldo), bank transactions for past days, manual entries + credit-card bill outflows for future days, running balance with one global realized/projected boundary, inline editing of descriptions/amounts/dates, drag-and-drop reordering within a day, ghost row for adding new entries. Clicking a credit-card bill drills into Overview.

**Overview** ([Overview.tsx](../packages/web/src/screens/Overview.tsx)) — "← voltar" to CashFlow → ←/→ month navigation (auto-advances when the next month has activity) → grand total with delta → aggregated category breakdown → aggregated `SplitSection` → grid of account cards plus a `ManageBankButton` dropdown (add/remove banks). Clicking an account card drills into Dashboard.

**Dashboard** ([Dashboard.tsx](../packages/web/src/screens/Dashboard.tsx)) — "← voltar" to Overview → account tabs (if multiple) → `BillHeader` (bill-cycle arrows, giant total, delta, closing/due dates, inline regras/sincronizar actions) → `SplitSection` (partner debt breakdown) → `CardGroupFilterBar` (chips to filter the list by card group + "gerenciar" link, hidden below `md`) → `CategoryTabs` → `TransactionInbox`.

**Login** ([Login.tsx](../packages/web/src/screens/Login.tsx)) — username + password. Renders when `/auth/me` reports unauthenticated, which only happens once at least one `USER_<NAME>_PASSWORD` is set; with none set the API authenticates everyone as `default` and this screen never appears.

**Onboarding** ([Onboarding.tsx](../packages/web/src/screens/Onboarding.tsx)) — shown when the user has zero linked items. Mounts `<PluggyConnect>` directly.

## Responsiveness

Mobile-aware throughout. The CashFlow ledger collapses to a compact column set on small screens (debit/credit columns merge, desktop-only headers hide). BillHeader's action buttons sit inline with the bill-cycle nav and "gerenciar regras" / "gerenciar bancos" links hide below `md`. SplitSection collapses to a single column.

## Data fetching

TanStack Query, no extra data layer: queries are declared in the component that consumes them. What is *not* colocated is the two things that are shared knowledge — the keys and the invalidation.

### Query keys

Never write a `queryKey` literal. Every key comes from [lib/queryKeys.ts](../packages/web/src/lib/queryKeys.ts):

```ts
useQuery({ queryKey: keys.billBreakdown.at(itemId, accountId, offset), ... })
queryClient.invalidateQueries({ queryKey: keys.billBreakdown.ofItem(itemId) })
```

Each domain exposes `all` (the broad prefix, for invalidation) plus narrower builders. **Narrow keys must always extend the broader ones**, so invalidating a parent reaches every descendant — `keys.transactions.all` ⊂ `.ofItem(id)` ⊂ `.list({...})`.

The reason this is a rule and not a preference: TanStack matches keys by prefix, so a literal that drifts from the one a query registered with fails *silently*. No type error, no runtime error, no failed request — just a panel showing the previous value until something else happens to refetch it. The compiler cannot see a string; it can see a missing method.

Some keys carry `null`. `billBreakdown.at` / `splitSummary.at` / `partnerCardBreakdown.at` take `offset: number | null` because Overview resolves one offset per account and leaves the query `enabled: false` when there is none — so `null` is a real key living in the cache. Do not coerce it to `0` in the factory; that would merge those entries with the genuine offset-0 ones.

### Transaction mutations

Mutations that edit a transaction inside a bill go in [lib/useBillMutations.ts](../packages/web/src/lib/useBillMutations.ts), not inline in a component. The hook owns cache invalidation **and nothing else** — UI side effects stay with the screen and are passed per call:

```ts
const { bulkCategorize } = useBillMutations({ itemId, accountId });
bulkCategorize.mutate({ txIds, categoryId }, { onSuccess: clearSelection });
```

Three server-side views derive from the same rows and must refetch together:

| view | what it sums |
| --- | --- |
| the transaction list | every row in the window, categorized or not |
| `GET /bills/current/breakdown` | categorized rows only |
| `GET /bills/current/split-summary` | categorized rows, grouped by ½ / dela / meu |

The third one is the trap, and it caused a real bug. Its SQL ([routes/splits.ts](../packages/api/src/routes/splits.ts)) does:

```sql
INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
LEFT  JOIN transaction_bill_overrides o ON o.transaction_id = t.id
WHERE  (o.shift IS NULL AND t.date BETWEEN ? AND ?)
    OR (o.shift = 1     AND t.date BETWEEN ? AND ?)
    OR (o.shift = -1    AND t.date BETWEEN ? AND ?)
```

Because it joins on categories and resolves its window through the shift override, **categorizing a row or shifting it into a neighbor cycle changes the split totals** — it is not only the split mutations that dirty this cache. When the twelve mutations each carried their own hand-written invalidation, only split and hide invalidated it, so the ½ / dela / meu columns kept showing stale numbers after a categorize or a shift.

A fourth cache is conditional: `GET /categories` orders by `usage_count`, so anything that assigns or clears a category also reorders the picker. Hence the hook's two shapes — `invalidateBill()` and `invalidateBillAndCategories()`.

When adding a mutation, the question to answer is not "which keys did the neighboring mutation use" but "which of those four views can this change move".

## Reusable UI patterns

- **Portal for any overlay that needs to escape row stacking contexts.** Used by `CategoryPicker`, `RowActionsMenu`, `CardGroupsManager`, and `ToastLayer`. Common shape: `createPortal` into `document.body`, `getBoundingClientRect` via `useLayoutEffect` for position, flip upward / right-align when near edges, listeners for `mousedown` outside / `scroll` outside (scroll **inside** the overlay is explicitly allowed) / `resize` / `Escape`.
- **`ToastProvider`** in [Toast.tsx](../packages/web/src/components/Toast.tsx) exposes `useToast()` with `show({ message, undo?, durationMs? })`. One toast at a time; a new one replaces the previous. Hover pauses the 6s countdown. Used after destructive actions (shifts, deletes) so the user has a recovery window.
- **`RowActionsMenu`** for rare per-row actions. Currently hosts bill-shift, manual-entry edit/delete, and split commands on each transaction row. Add more actions here before cluttering the row visually.
- **`SplitSection`** is the unified component for the "Divisão" panel. Used on both Dashboard (single account) and Overview (aggregated across accounts) — dynamic columns for ½ / dela / meu with totals, category breakdowns, and installments.

## Types

Frontend-facing types live in [packages/web/src/lib/apiTypes.ts](../packages/web/src/lib/apiTypes.ts) and are redeclared there to mirror the backend response shape — a hand-kept mirror, so a backend change not reflected here compiles fine and fails at runtime. No shared package between the workspaces; extract one only when a second consumer appears. [api.ts](../packages/web/src/lib/api.ts) next to it is the transport (`request<T>`, `ApiError`) plus one method per endpoint.
