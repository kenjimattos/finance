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
- [ ] **Categorization engine improvements** — the current slug-based system is good for the majority case but has known edge cases:
  - Slug granularity: "UBER *EATS" and "UBER *TRIP" collapse to the same slug "UBER". Preserving the second token would reduce false matches.
  - Ambiguous merchants: the same supermarket can be Alimentação or Casa depending on what was bought. The system should always apply the **majority** category (already changed in v0.1.0 — rules no longer auto-disable after overrides) and let the user correct the minority.
  - Future: a rules management UI so the user can see, edit, and delete learned rules explicitly (backend `GET /rules` already exists, no UI yet).

## Phase 4 — Cash flow (new feature area)

Separate screen projecting the future balance of the checking account. The credit card bill enters as an outflow on its due date. Manual entries (salary, rent, freelance) are added by the user.

Depends on:
- Phase 2 (needs to know which bill is due when, per account)
- Phase 3 navigation (projecting the future requires understanding the past)
- The Meu Pluggy connection **already provides** a BANK/CHECKING_ACCOUNT with balance and transactions — just not synced yet because the current code filters by `'CREDIT'`

Requires: new schema (`manual_entries` or similar), new screen, discussion before implementation.

## Anytime (independent, no sequencing constraint)

- [ ] **Visible rules UI** — screen to view/edit/delete learned category rules
- [ ] **Category icons or emoji** — visual identifier beyond auto-assigned color
- [ ] **Transaction search** — text filter on description within the inbox
- [ ] **Mobile responsiveness** — cards and inbox work on small screens but aren't optimized
- [ ] **Simplified local deploy** — `start.sh` script for cloning and running
- [ ] **Keep CHANGELOG updated** — add bullets as features land (format already established in v0.1.0)
