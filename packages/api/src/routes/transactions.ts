import { Router } from 'express';
import { z } from 'zod';
import type { Transaction, CreditCardMetadata } from 'pluggy-sdk';
import { pluggy } from '../services/pluggy.js';
import { db } from '../db/index.js';
import { applyLearnedRules } from '../services/applyLearnedRules.js';

export const transactionsRouter = Router();

const querySchema = z.object({
  itemId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  from: z.string().optional(), // yyyy-mm-dd
  to: z.string().optional(),
  refresh: z.enum(['true', 'false']).optional(),
  uncategorized: z.enum(['true', 'false']).optional(),
  // cardGroupId filters by card group membership:
  //   undefined → no filter (all cards)
  //   "none"    → only transactions from cards with NO group
  //   "<int>"   → only transactions from cards in that group
  cardGroupId: z.string().optional(),
  // When all four of these are passed together with `from`/`to`, the
  // handler switches to SHIFT-AWARE mode: transactions with manual
  // bill-shift overrides (±1 cycle) are matched against the neighboring
  // window instead of their raw date. Used by the dashboard so the inbox
  // reflects the same numbers the BillCardGrid shows.
  previousFrom: z.string().optional(),
  previousTo: z.string().optional(),
  nextFrom: z.string().optional(),
  nextTo: z.string().optional(),
});

interface TransactionRow {
  id: string;
  account_id: string;
  item_id: string;
  date: string;
  description: string | null;
  amount: number;
  currency_code: string | null;
  pluggy_category: string | null;
  pluggy_category_id: string | null;
  type: string | null;
  status: string | null;
  installment_number: number | null;
  total_installments: number | null;
  bill_id: string | null;
  card_last4: string | null;
  user_category_id: number | null;
  user_category_name: string | null;
  user_category_color: string | null;
  assigned_by: string | null;
  bill_shift: number | null;
}

/**
 * GET /transactions
 *   ?itemId=...              (required)
 *   &from=yyyy-mm-dd         (optional inclusive lower bound)
 *   &to=yyyy-mm-dd           (optional inclusive upper bound)
 *   &uncategorized=true      (optional: only rows without a user category)
 *   &refresh=true            (optional: re-sync from Pluggy before reading)
 *
 * Reads come from the local cache. A LEFT JOIN surfaces the user's
 * category (if any) alongside each transaction so the frontend gets
 * everything it needs in one round trip.
 */
transactionsRouter.get('/transactions', async (req, res, next) => {
  try {
    const {
      itemId,
      accountId,
      from,
      to,
      refresh,
      uncategorized,
      cardGroupId,
      previousFrom,
      previousTo,
      nextFrom,
      nextTo,
    } = querySchema.parse(req.query);

    if (refresh === 'true') {
      await syncItem(itemId);
    }

    const onlyUncategorized = uncategorized === 'true';
    const groupFilter = parseCardGroupFilter(cardGroupId);
    const filterByAccount = !!accountId;

    // Shift-aware mode kicks in only when the caller provides BOTH the
    // current window (from/to) AND both neighbor windows. Otherwise we fall
    // back to the plain date-range filter to stay backwards-compatible
    // with any caller that only wants a raw range.
    const shiftAware =
      !!from && !!to && !!previousFrom && !!previousTo && !!nextFrom && !!nextTo;

    const dateClause = shiftAware
      ? `AND (
             (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
          OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
          OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
        )`
      : `AND (? IS NULL OR t.date >= ?)
         AND (? IS NULL OR t.date <= ?)`;

    const dateParams = shiftAware
      ? [
          from, to,
          previousFrom, previousTo,
          nextFrom, nextTo,
        ]
      : [from ?? null, from ?? null, to ?? null, to ?? null];

    const rows = db
      .prepare(
        `SELECT t.id, t.account_id, t.item_id, t.date, t.description, t.amount,
                t.currency_code, t.pluggy_category, t.pluggy_category_id,
                t.type, t.status, t.installment_number, t.total_installments,
                t.bill_id, t.card_last4,
                uc.id    AS user_category_id,
                uc.name  AS user_category_name,
                uc.color AS user_category_color,
                tc.assigned_by,
                o.shift  AS bill_shift
         FROM transactions t
         LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
         LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
         LEFT JOIN card_group_members    m  ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
         LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
         WHERE t.item_id = ?
           AND (? = 0 OR t.account_id = ?)
           ${dateClause}
           AND (? = 0 OR tc.transaction_id IS NULL)
           AND (
             ? = 'any'
             OR (? = 'none' AND m.card_group_id IS NULL)
             OR (? = 'id'   AND m.card_group_id = ?)
           )
         ORDER BY t.date DESC, t.id DESC`,
      )
      .all(
        itemId,
        filterByAccount ? 1 : 0,
        accountId ?? null,
        ...dateParams,
        onlyUncategorized ? 1 : 0,
        groupFilter.kind,
        groupFilter.kind,
        groupFilter.kind,
        groupFilter.kind === 'id' ? groupFilter.id : null,
      ) as TransactionRow[];

    res.json(rows.map(shapeRow));
  } catch (err) {
    next(err);
  }
});

// PUT /transactions/:id/bill-shift { shift: -1 | 0 | 1 }
// shift = 0 clears the override entirely.
const shiftSchema = z.object({
  shift: z.number().int().min(-1).max(1),
});

transactionsRouter.put('/transactions/:id/bill-shift', (req, res, next) => {
  try {
    const { shift } = shiftSchema.parse(req.body);
    const transactionId = req.params.id;

    const tx = db
      .prepare('SELECT id FROM transactions WHERE id = ?')
      .get(transactionId);
    if (!tx) {
      res.status(404).json({ error: 'TransactionNotFound' });
      return;
    }

    if (shift === 0) {
      db.prepare(
        'DELETE FROM transaction_bill_overrides WHERE transaction_id = ?',
      ).run(transactionId);
    } else {
      db.prepare(
        `INSERT INTO transaction_bill_overrides (transaction_id, shift)
         VALUES (?, ?)
         ON CONFLICT(transaction_id) DO UPDATE SET
           shift = excluded.shift,
           created_at = datetime('now')`,
      ).run(transactionId, shift);
    }

    res.json({ ok: true, transactionId, shift });
  } catch (err) {
    next(err);
  }
});

/**
 * Parse the cardGroupId query param into a discriminated shape so the SQL
 * can branch cleanly. Kept as a pure function for reuse by /bills/current/breakdown.
 */
export function parseCardGroupFilter(
  raw: string | undefined,
): { kind: 'any' } | { kind: 'none' } | { kind: 'id'; id: number } {
  if (raw == null || raw === '') return { kind: 'any' };
  if (raw === 'none') return { kind: 'none' };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return { kind: 'any' };
  return { kind: 'id', id: parsed };
}

// POST /transactions/sync?itemId=... — explicit sync endpoint (mutating)
transactionsRouter.post('/transactions/sync', async (req, res, next) => {
  try {
    const { itemId } = z
      .object({ itemId: z.string().min(1) })
      .parse(req.query);
    const counts = await syncItem(itemId);
    res.json({ ok: true, ...counts });
  } catch (err) {
    next(err);
  }
});

/**
 * Re-sync a card from Pluggy: bills (closed), then transactions, then apply
 * learned rules to any transaction that doesn't already have a user category.
 *
 * Pluggy's Transaction.date is a Date object — we normalize it to
 * yyyy-mm-dd at the storage boundary so every downstream comparison
 * (billWindow ranges, UI date pills, etc.) can use plain string math.
 */
async function syncItem(itemId: string) {
  const { results: accounts } = await pluggy.fetchAccounts(itemId, 'CREDIT');

  // Upsert discovered accounts so downstream code (settings, groups, bill
  // windows) can reference them by account_id.
  const upsertAccount = db.prepare(`
    INSERT OR REPLACE INTO accounts
      (id, item_id, name, number, type, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const account of accounts) {
    upsertAccount.run(
      account.id,
      itemId,
      account.name ?? null,
      account.number ?? null,
      account.type ?? null,
      JSON.stringify(account),
    );
  }

  let txCount = 0;
  let billCount = 0;

  const insertTx = db.prepare(`
    INSERT OR REPLACE INTO transactions
      (id, account_id, item_id, date, description, amount, currency_code,
       pluggy_category, pluggy_category_id, type, status, installment_number,
       total_installments, bill_id, card_last4, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertBill = db.prepare(`
    INSERT OR REPLACE INTO bills
      (id, account_id, item_id, due_date, total_amount, currency_code,
       minimum_payment, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertTxBatch = db.transaction((txs: Transaction[], accountId: string) => {
    for (const t of txs) {
      const metadata: CreditCardMetadata | null = t.creditCardMetadata ?? null;
      insertTx.run(
        t.id,
        accountId,
        itemId,
        toYmd(t.date),
        t.description ?? null,
        t.amount,
        t.currencyCode ?? null,
        t.category ?? null,
        t.categoryId ?? null,
        t.type ?? null,
        t.status ?? null,
        metadata?.installmentNumber ?? null,
        metadata?.totalInstallments ?? null,
        metadata?.billId ?? null,
        lastFourDigits(metadata?.cardNumber),
        JSON.stringify(t),
      );
      txCount++;
    }
  });

  for (const account of accounts) {
    // Bills first — they're cheap and independent.
    try {
      const billsPage = await pluggy.fetchCreditCardBills(account.id);
      const upsertBillBatch = db.transaction(() => {
        for (const bill of billsPage.results) {
          insertBill.run(
            bill.id,
            account.id,
            itemId,
            toYmd(bill.dueDate),
            bill.totalAmount,
            bill.totalAmountCurrencyCode,
            bill.minimumPaymentAmount,
            JSON.stringify(bill),
          );
          billCount++;
        }
      });
      upsertBillBatch();
    } catch (err) {
      // Some connectors don't support bills; log and continue.
      console.warn(`[sync] fetchCreditCardBills failed for account ${account.id}:`, err);
    }

    const txPage = await pluggy.fetchTransactions(account.id, { pageSize: 500 });
    upsertTxBatch(txPage.results, account.id);
  }

  // Apply learned rules to transactions that don't yet have a user category.
  applyLearnedRules(db, itemId);

  return { transactions: txCount, bills: billCount };
}

/**
 * Normalize the cardNumber field from creditCardMetadata into a stable
 * identifier for grouping transactions by physical/virtual card.
 *
 * Pluggy connectors return this field in inconsistent shapes:
 *   - "1234"                       → numeric last-4
 *   - "****1234"                   → masked with last-4
 *   - "1234 **** **** 5678"        → full masked PAN
 *   - "DIGITAL-PICPAY"             → non-numeric identifier for virtual cards
 *   - null / undefined / ""        → no card info (internal entries like
 *                                    "pagamento de fatura")
 *
 * Rules:
 *   1. null/empty → null (no card association possible)
 *   2. Contains ≥4 digits → extract last 4 digits (covers most physical cards)
 *   3. Non-numeric string (like "DIGITAL-PICPAY") → keep as-is, uppercased
 *      and trimmed, so it surfaces as a distinct "card" the user can assign
 *      to a group in the card manager
 */
function lastFourDigits(raw: string | undefined | null): string | null {
  if (!raw || raw.trim() === '') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-4);
  // Non-numeric identifier (virtual card, digital wallet, etc.)
  return raw.trim().toUpperCase();
}

function toYmd(d: Date | string): string {
  if (typeof d === 'string') {
    // Pluggy sometimes returns date as string already; take the first 10 chars.
    return d.slice(0, 10);
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(desc: string | null): string | null {
  if (!desc) return desc;
  return desc.replace(INSTALLMENT_SUFFIX, '').trim() || desc;
}

function shapeRow(r: TransactionRow) {
  return {
    id: r.id,
    accountId: r.account_id,
    itemId: r.item_id,
    date: r.date,
    description: stripInstallmentSuffix(r.description),
    amount: r.amount,
    currencyCode: r.currency_code,
    pluggyCategory: r.pluggy_category,
    type: r.type,
    status: r.status,
    installmentNumber: r.installment_number,
    totalInstallments: r.total_installments,
    billId: r.bill_id,
    cardLast4: r.card_last4,
    billShift: r.bill_shift,
    userCategory:
      r.user_category_id == null
        ? null
        : {
            id: r.user_category_id,
            name: r.user_category_name,
            color: r.user_category_color,
            assignedBy: r.assigned_by,
          },
  };
}
