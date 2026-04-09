import { Router } from 'express';
import { z } from 'zod';
import { pluggy } from '../services/pluggy.js';
import { db } from '../db/index.js';

export const transactionsRouter = Router();

const querySchema = z.object({
  itemId: z.string().min(1),
  from: z.string().optional(), // yyyy-mm-dd
  to: z.string().optional(),
  refresh: z.enum(['true', 'false']).optional(),
});

// GET /transactions?itemId=...&from=...&to=...&refresh=true
// Fetches credit card transactions for all CREDIT accounts under the given item.
// By default serves from local cache; pass refresh=true to re-sync from Pluggy.
transactionsRouter.get('/transactions', async (req, res, next) => {
  try {
    const { itemId, from, to, refresh } = querySchema.parse(req.query);

    if (refresh === 'true') {
      await syncItemTransactions(itemId, from, to);
    }

    const rows = db
      .prepare(
        `SELECT * FROM transactions
         WHERE item_id = ?
           AND (? IS NULL OR date >= ?)
           AND (? IS NULL OR date <= ?)
         ORDER BY date DESC`,
      )
      .all(itemId, from ?? null, from ?? null, to ?? null, to ?? null);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function syncItemTransactions(itemId: string, from?: string, to?: string) {
  const { results: accounts } = await pluggy.fetchAccounts(itemId, 'CREDIT');

  const insert = db.prepare(`
    INSERT OR REPLACE INTO transactions
      (id, account_id, item_id, date, description, amount, currency_code,
       category, category_id, type, status, installment_number,
       total_installments, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const upsertMany = db.transaction((txs: any[], accountId: string) => {
    for (const t of txs) {
      insert.run(
        t.id,
        accountId,
        itemId,
        t.date,
        t.description ?? null,
        t.amount,
        t.currencyCode ?? null,
        t.category ?? null,
        t.categoryId ?? null,
        t.type ?? null,
        t.status ?? null,
        t.creditCardMetadata?.installmentNumber ?? null,
        t.creditCardMetadata?.totalInstallments ?? null,
        JSON.stringify(t),
      );
    }
  });

  for (const account of accounts) {
    const { results } = await pluggy.fetchTransactions(account.id, {
      from,
      to,
      pageSize: 500,
    });
    upsertMany(results, account.id);
  }
}
