# Pluggy SDK gotchas

Pluggy's official docs and SDK README have been wrong multiple times for this project. Before writing integration code, read the `.d.ts` files under `node_modules/pluggy-sdk/dist/types/`, and when in doubt about data shape, query the actual SQLite cache: `sqlite3 packages/api/data/finance.sqlite "SELECT ..."`.

## API shape surprises

- `fetchAccounts(itemId, 'CREDIT')` — positional second argument, not an options object.
- The bills method is `fetchCreditCardBills(accountId, options?)`, not `fetchBills`. It returns only **closed** bills; there is no `status` field and no "open bill" entity. The open bill window must be reconstructed locally from `closing_day` + `due_day` (see [billWindow.ts](../packages/api/src/services/billWindow.ts)).
- `Transaction.amount` sign convention varies by connector. For Meu Pluggy credit accounts: `DEBIT` (purchases) = positive, `CREDIT` (refunds) = negative. Verify with a SQL query against the cache when in doubt; don't trust the SDK type doc comments.
- `Transaction.amountInAccountCurrency` contains the BRL equivalent for foreign-currency transactions (e.g. USD purchases). Stored in `amount_in_account_currency` column; all SUM queries and the GET /transactions endpoint use `COALESCE(amount_in_account_currency, amount)` so foreign transactions display and sum in BRL.
- `Transaction.date` from Pluggy is a `Date` object, not a string. Normalize to `yyyy-mm-dd` at the storage boundary via `toYmd()` in [transactions.ts](../packages/api/src/routes/transactions.ts). Every downstream date comparison assumes `yyyy-mm-dd` strings.
- `fetchTransactions` is paginated — the SDK does not auto-page. The sync loops until `nextPage` is empty.
- Connect tokens are short-lived (~20 min); generate per widget session.
- Webhooks require HTTPS; localhost is not accepted. Use manual `POST /transactions/sync` for local dev.

## Credit-card metadata

- `creditCardMetadata.billId` links a transaction to its closed bill, populated only after the bill closes.
- `creditCardMetadata.installmentNumber` / `totalInstallments` are populated for parceladas; these are columns in the schema and surface in the split summary's installment sub-section.
- `creditCardMetadata.cardNumber` comes in inconsistent shapes across connectors (`"1234"`, `"****1234"`, `"1234 **** **** 5678"`). Normalized to last-4 via `lastFourDigits()` in [transactions.ts](../packages/api/src/routes/transactions.ts).
- Pluggy embeds `PARCxx/yy` directly in `description` for installments (e.g. `MERCADO*MERCADPARC05/10`), redundant with the structured `installmentNumber`/`totalInstallments`. Stripped in the API layer (`shapeRow` in transactions.ts) so all consumers get clean descriptions. Not mutated in storage.
- **"Pagamento recebido" entries are Pluggy-internal reconciliation records**, not real bill items. They have no `card_last4` and don't appear on the actual card statement. The categorized-only rule naturally excludes them when left uncategorized.
- For installments, `transaction.date` is the **posting date** (when the installment hits the bill), not the original purchase date. The real bill statement shows the original purchase date, so dates will differ when comparing against exported statements.

## Sync direction

Key on `t.type`, not on the sign of `t.amount`. Pluggy's sign convention varies across connectors. `tx.type === 'DEBIT'` is the stable way to know direction; reserve `SUM(amount)` for totals where the convention has already been verified for the connector in question.
