import { randomUUID } from 'node:crypto';
import type { Db } from './index.js';

export interface ManualTransactionInput {
  accountId: string;
  itemId: string;
  date: string; // yyyy-mm-dd
  description: string;
  amount: number; // signed: negative = CREDIT (refund/estorno)
  cardLast4?: string | null;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  categoryId?: number | null;
  /** When non-zero, also writes a transaction_bill_overrides row. */
  billShift?: number | null;
}

function manualTransactionType(amount: number): 'DEBIT' | 'CREDIT' {
  return amount < 0 ? 'CREDIT' : 'DEBIT';
}

/**
 * Insert a single manual transaction (source='manual') and any attached
 * category / bill-shift rows. Returns the minted local UUID.
 *
 * Shared by POST /transactions/manual and the fatura-screenshot importer so the
 * column set and type derivation stay in one place. Caller is responsible for
 * wrapping batches in db.transaction(...) for atomicity.
 */
export function insertManualTransaction(db: Db, input: ManualTransactionInput): string {
  const id = randomUUID();

  db.prepare(
    `INSERT INTO transactions
       (id, account_id, item_id, date, description, amount, currency_code,
        type, source, installment_number, total_installments, card_last4, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 'BRL', ?, 'manual', ?, ?, ?, '{}', datetime('now'))`,
  ).run(
    id,
    input.accountId,
    input.itemId,
    input.date,
    input.description,
    input.amount,
    manualTransactionType(input.amount),
    input.installmentNumber ?? null,
    input.totalInstallments ?? null,
    input.cardLast4 ?? null,
  );

  if (input.categoryId != null) {
    db.prepare(
      `INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by)
       VALUES (?, ?, 'manual')`,
    ).run(id, input.categoryId);
  }

  if (input.billShift != null && input.billShift !== 0) {
    db.prepare(
      `INSERT INTO transaction_bill_overrides (transaction_id, shift) VALUES (?, ?)`,
    ).run(id, input.billShift);
  }

  return id;
}
