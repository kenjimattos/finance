# Roadmap

Ideas and planned features, organized by implementation phase. The sequence is designed so each phase builds on the previous — no work is thrown away, and structural changes happen before features that depend on them.

Nothing here is committed to a timeline. When something moves to implementation, it gets commits and leaves this list.

---

## Phase 1 — Stabilize before growing

Small, high-leverage items that make the codebase safer to refactor.

- [x] **Tests for pure services** — `node --test` + `tsx` loader, 28 tests covering `billWindow` and `merchantSlug`. These functions will be refactored in phase 2; tests make that safe.
- [x] **Clean PARCxx/yy suffix globally** — stripped in `shapeRow` (API layer) so all consumers get clean descriptions.

## Phase 2 — Fatura por banco (structural) ✓

Completed. Each Pluggy item can contain multiple CREDIT accounts; each account has its own billing cycle, card groups, and bill window.

- [x] `accounts` table populated during sync from `fetchAccounts(itemId, 'CREDIT')`
- [x] `account_settings` replaces per-item `card_settings` (with backfill migration)
- [x] `card_groups` / `card_group_members` gain `account_id` column (with backfill)
- [x] `/bills/current/breakdown` accepts `accountId`, computes window per account
- [x] Frontend: account selector tabs at the top; within each account everything works as before
- [x] Onboarding: setup form asks closing/due per account

Legacy `card_settings` and item-scoped breakdown paths remain for backward compat but are no longer used by the frontend.

## Phase 3 — Depth in the current experience

Features that become essential once there are multiple accounts and months of history.

- [x] **Navigate between bill cycles** — ← / → arrows in the eyebrow to browse past bills. `computeBillWindowAtOffset(settings, offset)` is the core primitive; the breakdown endpoint accepts `?offset=N` (0 = open bill, -N = N cycles back). Labels switch to past tense and show month/year. Delta is shift-aware on both sides.
- [x] **Additive bill-shift model** — the ⋯ menu buttons now add ±1 to the current shift value (capped at ±1) instead of setting it absolutely. "Restaurar para esta fatura" appears naturally when undoing a shift.
- [ ] **Smarter bulk categorization** — when categorizing, suggest "apply to all with the same merchant?" instead of requiring manual multi-select. Essential for catching up on hundreds of uncategorized historical transactions.
- [ ] **Keyboard shortcuts in the inbox** — `j`/`k` navigate, `Space` selects, `c` opens picker, `u` undoes. Amplifies bulk categorization speed.
- [x] **Categorization engine improvements** — three changes landed:
  - Slug granularity: the token after `*` is now preserved when >= 3 alphabetic chars, so "UBER *EATS" → "UBER EATS" and "UBER *TRIP" → "UBER TRIP" produce different slugs. Short tokens ("IFOOD *A") still collapse. Legacy slugs are tried as fallback in `applyLearnedRules` so existing rules keep working.
  - Ambiguous merchants: `applyLearnedRules` picks the rule with the highest `hit_count` per slug (majority-wins) instead of arbitrary insertion order.
  - Rules management UI: full-screen overlay accessible via "regras" button — debounced search, inline category reassignment, delete with toast. Backend: `GET /rules?q=` filtering + `PATCH /rules/:id` for category reassignment.

## Phase 4 — Multi-bank overview

The app supports multiple Pluggy items (bank connections) in the backend but the frontend is hardcoded to `items[0]`. Adding a second bank requires a new overview screen.

- [ ] **Monthly overview screen** — groups all bills by due-month across all banks. ←/→ arrows navigate between months. Grand total at the top, one card per account showing total + closing/due dates. Clicking a card drills into the existing per-account Dashboard.
- [ ] **Add bank flow in overview** — "adicionar banco" button triggers PluggyConnect from the overview screen (not just from onboarding). New item saves and appears after sync + settings config.
- [ ] **`findOffsetForDueMonth` helper** — given card settings and a target year+month, returns the bill offset whose due date falls in that month. Different accounts have different cycles, so the same calendar month maps to different offsets per account.
- [ ] **Dashboard back navigation** — `onBack` prop renders a "← voltar" button to return to the overview.

Depends on: Phase 2 (per-account settings + billing), Phase 3 (offset-based navigation). Backend needs no new endpoints — the frontend resolves offsets per account and calls `getBillBreakdown` in parallel.

## Phase 5 — Cash flow (new feature area)

Separate screen projecting the future balance of the checking account. The credit card bill enters as an outflow on its due date. Manual entries (salary, rent, freelance) are added by the user.

Depends on:
- Phase 2 (needs to know which bill is due when, per account)
- Phase 4 (multi-bank overview provides the "what do I owe this month" aggregation)
- The Meu Pluggy connection **already provides** a BANK/CHECKING_ACCOUNT with balance and transactions — just not synced yet because the current code filters by `'CREDIT'`

Requires: new schema (`manual_entries` or similar), new screen, discussion before implementation.

## Anytime (independent, no sequencing constraint)

- [x] **Visible rules UI** — delivered as part of Phase 3 categorization engine improvements
- [ ] **Category icons or emoji** — visual identifier beyond auto-assigned color
- [ ] **Transaction search** — text filter on description within the inbox
- [ ] **Mobile responsiveness** — cards and inbox work on small screens but aren't optimized
- [ ] **Simplified local deploy** — `start.sh` script for cloning and running
- [ ] **Keep CHANGELOG updated** — add bullets as features land (format already established in v0.1.0)
