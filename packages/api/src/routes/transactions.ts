import { Router } from 'express';
import { z } from 'zod';
import { pluggy } from '../services/pluggy.js';
import type { Db } from '../db/index.js';
import { insertManualTransaction } from '../db/manualTransaction.js';
import { applyLearnedRules } from '../services/applyLearnedRules.js';
import {
  upsertCreditTransactions,
  toYmd,
} from '../services/syncCreditTransactions.js';

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
  provider_transaction_id: string | null;
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
  source: string | null;
  split_type: string | null;
  hidden: number;
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
    const { db } = req;
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
      await syncItem(db, itemId);
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
        `SELECT t.id, t.provider_transaction_id, t.account_id, t.item_id, t.date, t.description,
                COALESCE(t.amount_in_account_currency, t.amount) AS amount,
                t.currency_code, t.pluggy_category, t.pluggy_category_id,
                t.type, t.status, t.installment_number, t.total_installments,
                t.bill_id, t.card_last4, t.source,
                uc.id    AS user_category_id,
                uc.name  AS user_category_name,
                uc.color AS user_category_color,
                tc.assigned_by,
                o.shift  AS bill_shift,
                sp.split_type,
                (h.transaction_id IS NOT NULL) AS hidden
         FROM transactions t
         LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
         LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
         LEFT JOIN card_group_members    m  ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
         LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
         LEFT JOIN transaction_splits    sp ON sp.transaction_id = t.id
         LEFT JOIN transaction_hidden    h  ON h.transaction_id = t.id
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
    const { db } = req;
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

// PUT /transactions/:id/hidden { hidden: boolean }
// Hidden transactions are excluded from bill totals, breakdowns, split
// summaries, and PDF reconciliation, but stay flagged in GET /transactions
// so the inbox can list them in a collapsed section for un-hiding.
const hiddenSchema = z.object({
  hidden: z.boolean(),
});

transactionsRouter.put('/transactions/:id/hidden', (req, res, next) => {
  try {
    const { db } = req;
    const { hidden } = hiddenSchema.parse(req.body);
    const transactionId = req.params.id;

    const tx = db
      .prepare('SELECT id FROM transactions WHERE id = ?')
      .get(transactionId);
    if (!tx) {
      res.status(404).json({ error: 'TransactionNotFound' });
      return;
    }

    if (hidden) {
      db.prepare(
        `INSERT INTO transaction_hidden (transaction_id) VALUES (?)
         ON CONFLICT(transaction_id) DO NOTHING`,
      ).run(transactionId);
    } else {
      db.prepare(
        'DELETE FROM transaction_hidden WHERE transaction_id = ?',
      ).run(transactionId);
    }

    res.json({ ok: true, transactionId, hidden });
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

// ── Manual bill transactions ──────────────────────────────────────────
// These let the user add transactions that Pluggy missed (e.g. the
// connector didn't return them) directly into the transactions table
// with source='manual'. They participate in all bill window queries,
// categorization, and shifts exactly like Pluggy-synced rows.

const manualTxSchema = z
  .object({
    accountId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().min(1),
    amount: z.number(),
    cardLast4: z.string().optional(),
    categoryId: z.number().int().positive().optional(),
    installmentNumber: z.number().int().positive().nullable().optional(),
    totalInstallments: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (d) => (d.installmentNumber == null) === (d.totalInstallments == null),
    { message: 'installmentNumber and totalInstallments must be provided together' },
  )
  .refine(
    (d) =>
      d.installmentNumber == null ||
      d.totalInstallments == null ||
      d.installmentNumber <= d.totalInstallments,
    { message: 'installmentNumber must not exceed totalInstallments' },
  );

function manualTransactionType(amount: number): 'DEBIT' | 'CREDIT' {
  return amount < 0 ? 'CREDIT' : 'DEBIT';
}

// POST /transactions/manual — create a manual transaction
transactionsRouter.post('/transactions/manual', (req, res, next) => {
  try {
    const { db } = req;
    const body = manualTxSchema.parse(req.body);

    // Look up item_id from the account.
    const account = db
      .prepare('SELECT item_id FROM accounts WHERE id = ?')
      .get(body.accountId) as { item_id: string } | undefined;
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const id = insertManualTransaction(db, {
      accountId: body.accountId,
      itemId: account.item_id,
      date: body.date,
      description: body.description,
      amount: body.amount,
      cardLast4: body.cardLast4 ?? null,
      installmentNumber: body.installmentNumber ?? null,
      totalInstallments: body.totalInstallments ?? null,
      categoryId: body.categoryId ?? null,
    });

    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// PUT /transactions/manual/:id — update a manual transaction
const manualTxUpdateSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().min(1).optional(),
    amount: z.number().optional(),
    cardLast4: z.string().nullable().optional(),
    // Installment fields must be updated as a pair; pass both null to clear.
    installmentNumber: z.number().int().positive().nullable().optional(),
    totalInstallments: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (d) => (d.installmentNumber === undefined) === (d.totalInstallments === undefined),
    { message: 'installmentNumber and totalInstallments must be updated together' },
  )
  .refine(
    (d) => (d.installmentNumber == null) === (d.totalInstallments == null),
    { message: 'installmentNumber and totalInstallments must both be set or both cleared' },
  )
  .refine(
    (d) =>
      d.installmentNumber == null ||
      d.totalInstallments == null ||
      d.installmentNumber <= d.totalInstallments,
    { message: 'installmentNumber must not exceed totalInstallments' },
  );

transactionsRouter.put('/transactions/manual/:id', (req, res, next) => {
  try {
    const { db } = req;
    const id = req.params.id;
    const body = manualTxUpdateSchema.parse(req.body);

    // Only allow editing manual transactions.
    const tx = db
      .prepare("SELECT id FROM transactions WHERE id = ? AND source = 'manual'")
      .get(id);
    if (!tx) {
      res.status(404).json({ error: 'Manual transaction not found' });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.date !== undefined) {
      sets.push('date = ?');
      params.push(body.date);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(body.description);
    }
    if (body.amount !== undefined) {
      sets.push('amount = ?');
      params.push(body.amount);
      sets.push('type = ?');
      params.push(manualTransactionType(body.amount));
    }
    if (body.cardLast4 !== undefined) {
      sets.push('card_last4 = ?');
      params.push(body.cardLast4);
    }
    // The schema guarantees both installment fields move together.
    if (body.installmentNumber !== undefined) {
      sets.push('installment_number = ?');
      params.push(body.installmentNumber);
      sets.push('total_installments = ?');
      params.push(body.totalInstallments);
    }

    if (sets.length > 0) {
      params.push(id);
      db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /transactions/manual/:id — delete a manual transaction
transactionsRouter.delete('/transactions/manual/:id', (req, res, next) => {
  try {
    const { db } = req;
    const id = req.params.id;
    const result = db
      .prepare("DELETE FROM transactions WHERE id = ? AND source = 'manual'")
      .run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Manual transaction not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /transactions/sync?itemId=... — explicit sync endpoint (mutating)
transactionsRouter.post('/transactions/sync', async (req, res, next) => {
  try {
    const { db } = req;
    const { itemId } = z
      .object({ itemId: z.string().min(1) })
      .parse(req.query);
    const counts = await syncItem(db, itemId);
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
async function syncItem(db: Db, itemId: string) {
  const { results: creditAccounts } = await pluggy.fetchAccounts(itemId, 'CREDIT');
  console.log(`[sync] itemId=${itemId} found ${creditAccounts.length} CREDIT account(s):`, creditAccounts.map(a => ({ id: a.id, name: a.name, number: a.number })));

  let bankAccounts: typeof creditAccounts = [];
  try {
    const res = await pluggy.fetchAccounts(itemId, 'BANK');
    bankAccounts = res.results;
    console.log(`[sync] itemId=${itemId} found ${bankAccounts.length} BANK account(s):`, bankAccounts.map(a => ({ id: a.id, name: a.name, number: a.number })));
  } catch {
    // Item may not have bank accounts — that's fine.
  }

  const allAccounts = [...creditAccounts, ...bankAccounts];

  // Upsert discovered accounts so downstream code (settings, groups, bill
  // windows) can reference them by account_id.
  const upsertAccount = db.prepare(`
    INSERT INTO accounts
      (id, item_id, name, number, type, subtype, balance, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      item_id   = excluded.item_id,
      name      = excluded.name,
      number    = excluded.number,
      type      = excluded.type,
      subtype   = excluded.subtype,
      balance   = excluded.balance,
      raw_json  = excluded.raw_json,
      synced_at = datetime('now')
  `);
  const reassignTxItemId = db.prepare(
    `UPDATE transactions SET item_id = ? WHERE account_id = ? AND item_id != ?`,
  );
  for (const account of allAccounts) {
    upsertAccount.run(
      account.id,
      itemId,
      account.name ?? null,
      account.number ?? null,
      account.type ?? null,
      account.subtype ?? null,
      account.balance ?? null,
      JSON.stringify(account),
    );
    // If the account was previously synced under a different item (e.g. user
    // deleted and re-connected in the sandbox), existing transactions still
    // reference the old item_id. Fix them so GET /transactions?itemId=... works.
    reassignTxItemId.run(itemId, account.id, itemId);
  }

  // Snapshot BANK account balances so historical cashflow calculations
  // remain accurate even after Pluggy ages out old transactions.
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const snapshotBalance = db.prepare(`
    INSERT INTO balance_snapshots (account_id, date, balance)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET
      balance = excluded.balance,
      created_at = datetime('now')
  `);
  for (const account of bankAccounts) {
    if (account.balance != null) {
      snapshotBalance.run(account.id, todayYmd, account.balance);
    }
  }

  let txCount = 0;
  let billCount = 0;

  const insertBill = db.prepare(`
    INSERT INTO bills
      (id, account_id, item_id, due_date, total_amount, currency_code,
       minimum_payment, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      account_id      = excluded.account_id,
      item_id         = excluded.item_id,
      due_date        = excluded.due_date,
      total_amount    = excluded.total_amount,
      currency_code   = excluded.currency_code,
      minimum_payment = excluded.minimum_payment,
      raw_json        = excluded.raw_json,
      synced_at       = datetime('now')
  `);

  for (const account of allAccounts) {
    // Bills — only for CREDIT accounts (BANK accounts don't have bills).
    if (account.type === 'CREDIT') {
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
    }

    // Transactions — only CREDIT accounts. BANK transactions live in their
    // own table (`bank_transactions`) with their own naive sync, exposed
    // via POST /cashflow/sync. Fetching them here would write duplicate
    // rows into both tables.
    if (account.type !== 'CREDIT') continue;

    let page = 1;
    let totalPages = 1;
    do {
      const txPage = await pluggy.fetchTransactions(account.id, {
        pageSize: 500,
        page,
      });
      const counts = upsertCreditTransactions(db, txPage.results, account.id, itemId);
      txCount += counts.processed;
      totalPages = txPage.totalPages;
      page++;
    } while (page <= totalPages);
  }

  // Apply learned rules to transactions that don't yet have a user category.
  applyLearnedRules(db, itemId);

  return { transactions: txCount, bills: billCount };
}

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(desc: string | null): string | null {
  if (!desc) return desc;
  return desc.replace(INSTALLMENT_SUFFIX, '').trim() || desc;
}

function shapeRow(r: TransactionRow) {
  return {
    id: r.id,
    providerTransactionId: r.provider_transaction_id,
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
    source: r.source ?? 'pluggy',
    split: r.split_type as 'half' | 'theirs' | null,
    hidden: r.hidden === 1,
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
