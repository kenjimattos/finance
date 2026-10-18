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
  /** Stored as bill_shift; 0 or null means no shift. */
  billShift?: number | null;
}

function manualTransactionType(amount: number): 'DEBIT' | 'CREDIT' {
  return amount < 0 ? 'CREDIT' : 'DEBIT';
}

/**
 * Insert a single manual transaction (source='manual') with its optional
 * category and bill shift. Returns the minted local UUID.
 *
 * Shared by POST /transactions/manual and the fatura-screenshot importer so the
 * column set and type derivation stay in one place. Caller is responsible for
 * wrapping batches in db.transaction(...) for atomicity.
 */
export function insertManualTransaction(db: Db, input: ManualTransactionInput): string {
  const id = randomUUID();

  const hasCategory = input.categoryId != null;
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, item_id, date, description, amount, currency_code,
        type, source, installment_number, total_installments, card_last4, raw_json, synced_at,
        category_id, category_assigned_by, category_assigned_at, bill_shift)
     VALUES (?, ?, ?, ?, ?, ?, 'BRL', ?, 'manual', ?, ?, ?, '{}', datetime('now'),
             ?, ?, CASE WHEN ? THEN datetime('now') END, ?)`,
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
    hasCategory ? input.categoryId : null,
    hasCategory ? 'manual' : null,
    hasCategory ? 1 : 0,
    input.billShift ? input.billShift : null,
  );

  return id;
}
