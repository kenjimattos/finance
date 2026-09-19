# Pluggy SDK gotchas

Pluggy's official docs and SDK README have been wrong multiple times for this project. Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`, and when in doubt about data shape, query the actual SQLite cache. There is one file per user under `DATABASE_DIR` (`./packages/api/data/` in dev), named after the username — so `sqlite3 packages/api/data/kenji.sqlite "SELECT ..."`, not a single shared `finance.sqlite`.

## API shape surprises

- `fetchAccounts(itemId, 'CREDIT')` — positional second argument, not an options object.
- The bills method is `fetchCreditCardBills(accountId, options?)`, not `fetchBills`. It returns only **closed** bills; there is no `status` field and no "open bill" entity. The open bill window must be reconstructed locally from `closing_day` + `due_day` (see [billWindow.ts](../packages/api/src/services/billWindow.ts)).
- `Transaction.amount` sign convention varies by connector. For Meu Pluggy credit accounts: `DEBIT` (purchases) = positive, `CREDIT` (refunds) = negative. Verify with a SQL query against the cache when in doubt; don't trust the SDK type doc comments.
- `Transaction.amountInAccountCurrency` contains the BRL equivalent for foreign-currency transactions (e.g. USD purchases). Stored in `amount_in_account_currency` column; all SUM queries and the GET /transactions endpoint use `COALESCE(amount_in_account_currency, amount)` so foreign transactions display and sum in BRL.
- `Transaction.date` from Pluggy is a `Date` object, not a string. Normalize to `yyyy-mm-dd` at the storage boundary via `toYmd()` in [syncCreditTransactions.ts](../packages/api/src/services/syncCreditTransactions.ts). Every downstream date comparison assumes `yyyy-mm-dd` strings. The full instant is not thrown away: it feeds the identity hash (`toInstant()`) and stays in `raw_json`.
- `fetchTransactions` is paginated — the SDK does not auto-page. The sync walks `totalPages` and collects every page of an account before writing, because the dedup logic needs the complete set of IDs served in that sync.
- Connect tokens are short-lived (~20 min); generate per widget session.
- Webhooks require HTTPS; localhost is not accepted. Use manual `POST /transactions/sync` for local dev.

## Credit-card metadata

- `creditCardMetadata.billId` links a transaction to its closed bill, populated only after the bill closes.
- `creditCardMetadata.installmentNumber` / `totalInstallments` are populated for parceladas; these are columns in the schema and surface in the split summary's installment sub-section.
- `creditCardMetadata.cardNumber` comes in inconsistent shapes across connectors (`"1234"`, `"****1234"`, `"1234 **** **** 5678"`). Normalized to last-4 via `lastFourDigits()` in [syncCreditTransactions.ts](../packages/api/src/services/syncCreditTransactions.ts).
- Pluggy embeds `PARCxx/yy` directly in `description` for installments (e.g. `MERCADO*MERCADPARC05/10`), redundant with the structured `installmentNumber`/`totalInstallments`. Stripped in the API layer (`shapeRow` in transactions.ts) so all consumers get clean descriptions. Not mutated in storage.
- **"Pagamento recebido" entries are Pluggy-internal reconciliation records**, not real bill items. They have no `card_last4` and don't appear on the actual card statement. The categorized-only rule naturally excludes them when left uncategorized.
- For installments, `transaction.date` is the **posting date** (when the installment hits the bill), not the original purchase date. The real bill statement shows the original purchase date, so dates will differ when comparing against exported statements.

## Identity across syncs

A provider transaction ID is not a stable identity, and each connector breaks it differently. What we have observed in production (the payload history in `transaction_payloads` exists to keep observing it):

- **Itaú re-mints the ID when a purchase posts.** The PENDING and the POSTED are two different provider IDs. The PENDING stops being served before the POSTED appears (in the Sept 2026 case, it disappeared on 20/08 and the POSTED arrived on 11/09); no production pair has ever been served side by side.
- **Itaú shifts the time by exactly -3h on posting.** Same minutes, seconds and milliseconds, three hours earlier — consistent with one side carrying Brasília local time labeled as UTC. It can move the calendar date across midnight UTC.
- **Itaú's older records carry a synthetic `18:00:01.000` time.** Two real purchases of the same amount at the same merchant on the same day therefore share an exact instant; they are told apart only by being served side by side under two IDs.
- **PicPay re-mints the ID of the same purchase on every daily scrape**, keeping the instant to the millisecond.
- **PicPay has mutated stale PENDING records in place** (2026-07): description and date rewritten while `descriptionRaw` and `amount` kept the old content. See the chimera guard in [sync.md](sync.md).
- **A timestamp of exactly `03:00:00.000Z` means "date only"** (midnight in Brasília). Nubank's "Pagamento recebido" pairs show it: one side at 03:00:00, the other with a real time, both served permanently.

How the sync engine turns these into rules is in [sync.md](sync.md#transaction-identity-model).

## Sync direction

Key on `t.type`, not on the sign of `t.amount`. Pluggy's sign convention varies across connectors. `tx.type === 'DEBIT'` is the stable way to know direction; reserve `SUM(amount)` for totals where the convention has already been verified for the connector in question.
