import { Router } from 'express';
import { z } from 'zod';
import type { Transaction, CreditCardMetadata } from 'pluggy-sdk';
import { pluggy } from '../services/pluggy.js';
import { db } from '../db/index.js';
import { extractMerchantSlug } from '../services/merchantSlug.js';

export const transactionsRouter = Router();

const querySchema = z.object({
  itemId: z.string().min(1),
  from: z.string().optional(), // yyyy-mm-dd
  to: z.string().optional(),
  refresh: z.enum(['true', 'false']).optional(),
  uncategorized: z.enum(['true', 'false']).optional(),
  // cardGroupId filters by card group membership:
  //   undefined → no filter (all cards)
  //   "none"    → only transactions from cards with NO group
  //   "<int>"   → only transactions from cards in that group
  cardGroupId: z.string().optional(),
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
    const { itemId, from, to, refresh, uncategorized, cardGroupId } =
      querySchema.parse(req.query);

    if (refresh === 'true') {
      await syncItem(itemId);
    }

    const onlyUncategorized = uncategorized === 'true';
    const groupFilter = parseCardGroupFilter(cardGroupId);

    const rows = db
      .prepare(
        `SELECT t.id, t.account_id, t.item_id, t.date, t.description, t.amount,
                t.currency_code, t.pluggy_category, t.pluggy_category_id,
                t.type, t.status, t.installment_number, t.total_installments,
                t.bill_id, t.card_last4,
                uc.id    AS user_category_id,
                uc.name  AS user_category_name,
                uc.color AS user_category_color,
                tc.assigned_by
         FROM transactions t
         LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
         LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
         LEFT JOIN card_group_members    m  ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
         WHERE t.item_id = ?
           AND (? IS NULL OR t.date >= ?)
           AND (? IS NULL OR t.date <= ?)
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
        from ?? null,
        from ?? null,
        to ?? null,
        to ?? null,
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
  applyLearnedRules(itemId);

  return { transactions: txCount, bills: billCount };
}

/**
 * For every transaction belonging to this item that has no user category yet,
 * derive its merchant slug and see if a non-disabled rule exists for it. If
 * so, assign the rule's category with assigned_by='learned'.
 *
 * Kept deliberately simple: one SQL query to find candidates, one in-memory
 * pass, one transaction to write. No ordering/priority — a merchant_slug
 * has at most one active rule thanks to the UNIQUE index.
 */
function applyLearnedRules(itemId: string) {
  const candidates = db
    .prepare(
      `SELECT t.id, t.description
       FROM transactions t
       LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
       WHERE t.item_id = ? AND tc.transaction_id IS NULL`,
    )
    .all(itemId) as Array<{ id: string; description: string | null }>;

  if (candidates.length === 0) return;

  const ruleBySlug = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT merchant_slug, user_category_id
       FROM category_rules
       WHERE disabled = 0`,
    )
    .all() as Array<{ merchant_slug: string; user_category_id: number }>) {
    ruleBySlug.set(row.merchant_slug, row.user_category_id);
  }

  if (ruleBySlug.size === 0) return;

  const assign = db.prepare(
    `INSERT OR IGNORE INTO transaction_categories
       (transaction_id, user_category_id, assigned_by)
     VALUES (?, ?, 'learned')`,
  );
  const bumpRule = db.prepare(
    `UPDATE category_rules SET hit_count = hit_count + 1
     WHERE merchant_slug = ? AND user_category_id = ?`,
  );

  db.transaction(() => {
    for (const tx of candidates) {
      const slug = extractMerchantSlug(tx.description);
      if (!slug) continue;
      const categoryId = ruleBySlug.get(slug);
      if (!categoryId) continue;
      assign.run(tx.id, categoryId);
      bumpRule.run(slug, categoryId);
    }
  })();
}

/**
 * Pluggy returns the cardNumber field in creditCardMetadata with inconsistent
 * shapes across connectors: some send just "1234", others send "****1234",
 * others send the full masked string like "1234 **** **** 5678". We only
 * care about the last 4 digits for display, so normalize to exactly that,
 * or null if the input doesn't contain 4 digits.
 */
function lastFourDigits(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
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

function shapeRow(r: TransactionRow) {
  return {
    id: r.id,
    accountId: r.account_id,
    itemId: r.item_id,
    date: r.date,
    description: r.description,
    amount: r.amount,
    currencyCode: r.currency_code,
    pluggyCategory: r.pluggy_category,
    type: r.type,
    status: r.status,
    installmentNumber: r.installment_number,
    totalInstallments: r.total_installments,
    billId: r.bill_id,
    cardLast4: r.card_last4,
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
