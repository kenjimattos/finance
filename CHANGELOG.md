# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Dashboard: navegação de fatura agora permite avançar**: a seta "→" do `BillHeader` deixa de travar em `offset = 0` e passa a ser habilitada quando o próximo ciclo tem lançamentos (incluindo shifts ±1). O backend retorna `hasNextBillTransactions` em `GET /bills/current/breakdown`, computado com o mesmo padrão shift-aware de três janelas (current/previous/next). Os labels "fecha em/fechou em" e "vence em/venceu em" agora se baseiam na data real vs hoje, já que ciclos futuros são navegáveis.
- **Overview: navegação de mês agora permite avançar**: a seta "→" deixa de travar em `defaultMonth + 1` e passa a ser habilitada quando o mês seguinte tem lançamentos — seja em qualquer cartão (via `hasNextBillTransactions` agregado dos breakdowns) ou no fluxo de caixa (bank transactions, manual entries ou projeções de fatura). Uma query de cashflow do mês +1 é feita em paralelo só para isso.
- **CashFlow: projeções múltiplas**: o toggle único de projeção foi substituído por controles `+ projetar mês` e `− remover último`, permitindo estender a visualização em até 12 meses à frente. A quantidade é persistida em `localStorage` (`cashflow:projectionCount`). Remover afeta apenas meses de projeção (que contêm só lançamentos manuais); meses com dados bancários reais não têm botão de remover.

## [1.3.1] - 2026-04-24

### Changed

- **Dashboard sem breakdown por grupo de cartão**: a seção "Divisão" agora supre a necessidade de entender como a fatura se distribui, então a grade de cartões-por-grupo foi removida. O endpoint `GET /bills/current/breakdown` retorna um objeto único (`total`, `previousTotal`, `delta`, `categories`, `installments`) em vez de um array `groups[]`. No frontend, `BillCardGrid` foi substituído por `BillHeader` (headline editorial com navegação de ciclo) e `CardGroupFilterBar` (chips para filtrar a lista por grupo + botão "gerenciar"). O mecanismo de agrupar cartões continua — só não dirige mais totais por cartão.
- **Seções padronizadas acima do inbox**: Divisão, Cartões e Categorias agora compartilham a mesma cabeçalho (ponto laranja + título em accent uppercase + contagem entre parênteses em mono) e ficam separadas do bloco anterior com `rule-top mt-10 pt-6`.
- **`account_id` de grupos de cartão realinhados**: `card_groups` e `card_group_members` cujos `account_id` apontavam para contas que não existem mais foram re-apontados para a conta CREDIT atual do mesmo item (via SQL direto no banco do usuário).

### Removed

- **Botão "copiar para splitwise"**: o export via clipboard foi removido do painel de Divisão no Dashboard e no Overview. Não haverá integração com Splitwise e a funcionalidade não estava sendo usada. Também limpamos a função `copyToClipboard`, estado `copied`, helpers `formatDay`/`formatDueDateLabel`, a acumulação de transações no split agregado e os props `displayName`/`dueDate` do `SplitSummaryCard`.
- **`ROADMAP.md`**: arquivo de roadmap removido do repositório — planejamento passou a viver fora do repo.

## [1.3.0] - 2026-04-24

### Added

- **UUID local como chave primária de transações**: `transactions.id` é agora um UUID gerado localmente (estável para sempre). O ID do Pluggy migrou para `provider_transaction_id`, que é non-unique e nullable para transações manuais. Migração automática no startup reemite UUIDs para todas as linhas existentes e reaponta as 5 tabelas de trabalho do usuário (`transaction_categories`, `transaction_bill_overrides`, `transaction_description_overrides`, `bill_payment_tags`, `transaction_splits`).
- **Lógica de sync em 3 vias**: ao sincronizar, cada transação do Pluggy segue um de três caminhos — (1) provider ID novo → INSERT com UUID local novo; (2) mesmo provider ID, hash igual ou NULL → UPDATE apenas campos mutáveis; (3) mesmo provider ID, hash diferente → ID reciclado pelo Pluggy: mantém linha antiga intacta, insere nova linha com UUID novo e registra auditoria em `transaction_sync_conflicts`.
- **Tabela de auditoria `transaction_sync_conflicts`**: registra cada evento de reciclagem de ID com os payloads antigo e novo para diagnóstico futuro.
- **Identity hash portável entre reconexões**: o hash de identidade (`SHA-256(date|amount|merchant_slug)`) não inclui mais `account_id`, tornando-o portável quando o Pluggy emite novos IDs de conta ao reconectar o mesmo banco. Um fallback `findByIdentityHash` no sync detecta a reconexão e faz UPDATE em vez de INSERT, preservando categorias, splits e overrides existentes.
- **Swap cirúrgico de item/conta no banco**: scripts de migração para substituir IDs de item e de contas Pluggy em todas as tabelas relacionadas (`items`, `accounts`, `transactions`, `bills`, `account_settings`, `balance_snapshots`, `card_groups`, `card_group_members`, `card_settings`) atomicamente com `PRAGMA foreign_keys = OFF`.

### Changed

- **Hash de identidade sem `accountId`**: a fórmula anterior incluía o account ID do Pluggy, o que tornava o hash inválido após reconexão. A nova fórmula (`date|amount|slug`) é estável mesmo com account IDs diferentes para o mesmo cartão físico.
- Sync (CREDIT e BANK) não usa mais `INSERT OR REPLACE`. Todas as escritas passam pela lógica de 3 vias para preservar o trabalho do usuário.

## [1.2.1] - 2026-04-23

### Added

- **Tipo de transação manual**: formulário de lançamento manual aceita agora crédito ou débito. O campo "tipo" distingue compras (débito) de estornos/créditos, e o valor é armazenado com o sinal correto para que o saldo da fatura reflita a operação.
- **Campo de ano editável**: o formulário de data de transações manuais inclui agora um campo de ano, permitindo registrar lançamentos em anos diferentes do corrente (útil para notas de anos anteriores ou ajustes retroativos).

## [1.2.0] - 2026-04-23

### Added

- **Bill splitting (Splitwise prep)**: mark transactions as shared with a partner — "½" (50/50) or "→dela" (partner owes 100%). Per-row actions in the ⋯ menu plus bulk split buttons in the selection bar. Backend: `PUT/DELETE /transactions/:id/split`, `POST /transactions/bulk-split`, `POST /transactions/bulk-unsplit`, `GET /bills/current/split-summary` (with categories + installments). Data stored in `transaction_splits` join table (survives re-syncs).
- **Split summary in Dashboard**: per-account "Divisão" section below the card grid with partner debt total, half/theirs/meu columns, category breakdowns, installments, and "copiar para Splitwise" button.
- **Aggregated split summary in Overview**: all-account "Divisão" section for the selected due month, combining split totals, categories, installments, and copy text across cards.

### Changed

- **Implicit "mine" split model**: categorized transactions without a split row are treated as "meu" in split summaries. The persisted split types are now only `half` and `theirs`; unmarking a split returns a transaction to implicit mine.
- **Split summary layout**: categories and installments are grouped into separate ½, dela, and meu columns with column totals and full-amount breakdowns.
- **Dynamic split columns**: split sections only render the columns that have data, keeping one- and two-column states compact.

### Fixed

- **Pluggy recycled transaction IDs**: sync detects when Pluggy reuses an existing transaction ID for different transaction content, clears dependent user joins for that stale row, and replaces it safely instead of preserving mismatched categorization/split data.
- **Split summary placement**: the Dashboard split summary now sits below the bill card grid instead of being embedded as a grid card.

## [1.1.0] - 2026-04-21

### Added

- **Manual bill transactions**: add, edit, and delete manual transactions directly in the credit card bill inbox when Pluggy fails to return them. Manual entries participate in all bill window queries, categorization, shifts, and breakdown totals. Marked with an orange "manual" badge; edit/delete via the ⋯ menu. API: `POST/PUT/DELETE /transactions/manual`.
- **Cashflow-only sync button**: sync bank account transactions without triggering a full credit card sync, for faster balance updates on the CashFlow screen.

### Changed

- **Compact date fields**: replaced native date input with compact day/month fields for manual bill transaction entry.

### Fixed

- **Paginated transaction fetch**: sync now fetches all pages from Pluggy's `fetchTransactions`, fixing incomplete data when accounts have more than one page of transactions.
- **Cashflow cutoff boundary**: uses the data coverage boundary (last transaction date) instead of today's date to determine the realized/projected cutoff, preventing gaps when Pluggy data lags behind.
- **Vite dev server port**: updated from 5173 to 5174 to avoid conflicts.

## [1.0.0] - 2026-04-13

The app now covers both sides of personal finance — credit card bills (categorization, multi-bank) and checking account cash flow (realized + projected) — in a single Overview landing page.

### Added

#### Overview as landing page (Caixa + Cartões)

- **Overview is now the top-level screen**, divided into two editorial sections:
  - **Caixa** — monthly cash flow summary: saldo (realized, based on last past day), entradas, saídas (excluding faturas) with delta vs previous month, faturas highlighted in accent color. "ver extrato →" drills into the full CashFlow ledger.
  - **Cartões** — all credit card bills grouped by due-month: grand total with delta, aggregated category breakdown with proportional bars, per-account cards with closing/due dates.
- **Next-month projection**: ←/→ navigation goes one month into the future. Future months show projected saldo based on manual entries + credit card bill outflows. Label switches to "saldo projetado".

#### CashFlow improvements

- **Dynamic month range**: fetches actual date range of BANK transactions from `GET /cashflow/range`. Only months with data are shown.
- **History toggle**: previous months hidden by default behind "mostrar N meses anteriores" (up to 5).
- **Projection month**: "+ projeção" toggle at the bottom shows the next month's projected entries, fully editable and independent.
- **Per-month manual entries**: manual entries now belong to a specific month (`month` column). Editing in one month does not affect others. Each month has its own "nova entrada" ghost row.
- **Duplicate entries**: `++` duplicates within the same month, `+→` duplicates to the next month. Compact monospace buttons on hover.
- **Bill payment tagging**: click the source/origin column on any realized bank transaction to toggle it as a credit card bill payment. Tagged entries show an accent-colored "fatura" label. Both auto-detection (description matching) and manual tags feed the Overview's faturas total.
- **Balance snapshots** (`balance_snapshots` table): records the Pluggy-reported bank balance at each sync. Historical months use the nearest snapshot as anchor for opening-balance calculations, staying accurate even after Pluggy ages out old transactions.

### Changed

- App routing: Overview (landing) → CashFlow or Dashboard (both with back buttons).
- Main content area widened from 960px to 1120px for more room in the CashFlow ledger.
- Saídas in the Caixa section now excludes faturas (shown separately) to avoid double-counting.

### Fixed

- Caixa saldo reflects realized balance only (opening + past bank transactions), not projections.
- Opening balance uses the closest balance snapshot (before or after target month), fixing ~R$ 346 drift on older months.

## [0.2.0] - 2026-04-12

### Added

#### Phase 4 — Multi-bank overview

- **Overview screen** (`Overview.tsx`): groups all credit card bills by due-month across all banks. ←/→ arrows navigate between months. Grand total with delta vs previous period at the top, aggregated category breakdown with proportional bars, one card per account showing total + delta + closing/due dates.
- **`findOffsetForDueMonth` helper**: given card settings and a target year+month, returns the bill offset whose due date falls in that month. Backend + lightweight frontend mirror. 7 new tests (55 total).
- **Add/remove bank in Overview**: "Adicionar banco" card opens PluggyConnect to connect a new item. "remover" button on each card with confirmation deletes the item via `DELETE /items/:id` with cascade cleanup. Unconfigured accounts render as "Configurar →" cards that drill into the setup form.
- **Dashboard back navigation**: `onBack` prop renders a "← voltar" button. Month state lifted to App so returning preserves the month being browsed.
- **Sync-all button** in Overview: fetches all items in parallel, then invalidates all queries.
- **Foreign-currency support**: `amountInAccountCurrency` from Pluggy is now stored and used for display and sums, so USD transactions show their BRL equivalent instead of raw dollar amounts.

#### Phase 3 — Depth in the current experience

- **Bill-cycle navigation**: ← / → arrows browse past bills. `computeBillWindowAtOffset(settings, offset)` is the core primitive; breakdown endpoint accepts `?offset=N`. Labels switch to past tense with month/year.
- **Rules management UI**: full-screen overlay via "regras" button — debounced search, inline category reassignment, delete with toast. Backend: `GET /rules?q=` filtering + `PATCH /rules/:id`.
- **Slug granularity improvement**: token after `*` preserved when ≥ 3 alphabetic chars ("UBER *EATS" → "UBER EATS" vs "UBER *TRIP" → "UBER TRIP"). Legacy slugs tried as fallback.
- **Majority-wins rule resolution**: `applyLearnedRules` picks the rule with the highest `hit_count` per slug instead of arbitrary insertion order.

#### Phase 2 — Per-account billing

- **`accounts` table**: populated during sync from `fetchAccounts(itemId, 'CREDIT')`.
- **`account_settings`**: per-account `closing_day` / `due_day`, replacing per-item `card_settings` (with backfill migration).
- **Account selector tabs**: shown when a single item has multiple CREDIT accounts.
- **Per-account breakdown and transactions**: all queries scoped by `accountId`.

#### Phase 1 — Stability

- **Test suite**: 28 tests covering `billWindow` and `merchantSlug`. Zero new dependencies.
- **`applyLearnedRules` tests**: 11 cases against in-memory SQLite. Locks the non-overwrite invariant.

### Changed

- Dev servers (Vite + Express) now bind to `0.0.0.0`, allowing access from other devices on the local network.
- **`applyLearnedRules` extracted** into its own service module, taking a `Database` parameter for testability.
- **Additive bill-shift model**: ⋯ menu buttons add ±1 to the current shift (capped at ±1) instead of setting absolutely. "Restaurar para esta fatura" appears naturally when undoing.
- `previousTotal` in breakdown is now shift-aware on both sides.
- App routing: Onboarding → Overview → Dashboard drill-down (was Onboarding → Dashboard).

### Fixed

- `PARCxx/yy` installment suffix stripped in `shapeRow` (API layer) instead of only in the frontend.
- `INSERT OR REPLACE` replaced with `ON CONFLICT UPDATE` in sync to avoid cascade-deleting user work.
- Foreign-currency transactions (USD) now display and sum in BRL via `COALESCE(amount_in_account_currency, amount)`.
- Transaction `item_id` realigned when an account moves between Pluggy items (sandbox re-connection scenario).

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
