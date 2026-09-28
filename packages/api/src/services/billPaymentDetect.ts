/**
 * Does a bank row look like a credit-card bill payment?
 *
 * Runs only when a BANK transaction first arrives in the sync: a match writes
 * the same `bank_bill_payment_tags` row the CashFlow toggle writes. Rows that
 * already exist are never re-evaluated, so whatever the user toggled stays put
 * and older history keeps whatever tags it had.
 *
 * Outflows only — a refund or reversal mentioning "fatura" is not a payment.
 * Matches on Pluggy's description, never on a user override.
 */
export function looksLikeBillPayment(description: string | null, amount: number): boolean {
  if (amount >= 0 || !description) return false;
  return /fatura/i.test(description) || /^INT\s/i.test(description);
}
