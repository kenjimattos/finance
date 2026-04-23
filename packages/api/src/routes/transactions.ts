import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Transaction, CreditCardMetadata } from 'pluggy-sdk';
import { pluggy } from '../services/pluggy.js';
import { db } from '../db/index.js';
import { applyLearnedRules } from '../services/applyLearnedRules.js';
import { extractMerchantSlug } from '../services/merchantSlug.js';

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
                sp.split_type
         FROM transactions t
         LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
         LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
         LEFT JOIN card_group_members    m  ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
         LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
         LEFT JOIN transaction_splits    sp ON sp.transaction_id = t.id
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

// PUT /transactions/:id/description — override a transaction's display description
transactionsRouter.put('/transactions/:id/description', (req, res, next) => {
  try {
    const txId = req.params.id;
    const { description } = z
      .object({ description: z.string().min(1) })
      .parse(req.body);

    // Verify transaction exists.
    const tx = db
      .prepare('SELECT id FROM transactions WHERE id = ?')
      .get(txId);
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    db.prepare(
      `INSERT INTO transaction_description_overrides (transaction_id, description)
       VALUES (?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET description = excluded.description`,
    ).run(txId, description);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /transactions/:id/description — remove description override
transactionsRouter.delete('/transactions/:id/description', (req, res, next) => {
  try {
    const txId = req.params.id;
    db.prepare(
      'DELETE FROM transaction_description_overrides WHERE transaction_id = ?',
    ).run(txId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Manual bill transactions ──────────────────────────────────────────
// These let the user add transactions that Pluggy missed (e.g. the
// connector didn't return them) directly into the transactions table
// with source='manual'. They participate in all bill window queries,
// categorization, and shifts exactly like Pluggy-synced rows.

const manualTxSchema = z.object({
  accountId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1),
  amount: z.number(),
  cardLast4: z.string().optional(),
  categoryId: z.number().int().positive().optional(),
});

function manualTransactionType(amount: number): 'DEBIT' | 'CREDIT' {
  return amount < 0 ? 'CREDIT' : 'DEBIT';
}

// POST /transactions/manual — create a manual transaction
transactionsRouter.post('/transactions/manual', (req, res, next) => {
  try {
    const body = manualTxSchema.parse(req.body);
    const id = randomUUID();

    // Look up item_id from the account.
    const account = db
      .prepare('SELECT item_id FROM accounts WHERE id = ?')
      .get(body.accountId) as { item_id: string } | undefined;
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    db.prepare(
      `INSERT INTO transactions
        (id, account_id, item_id, date, description, amount, currency_code,
         type, source, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 'BRL', ?, 'manual', '{}', datetime('now'))`,
    ).run(
      id,
      body.accountId,
      account.item_id,
      body.date,
      body.description,
      body.amount,
      manualTransactionType(body.amount),
    );

    if (body.cardLast4) {
      db.prepare('UPDATE transactions SET card_last4 = ? WHERE id = ?').run(
        body.cardLast4,
        id,
      );
    }

    if (body.categoryId) {
      db.prepare(
        `INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by)
         VALUES (?, ?, 'manual')`,
      ).run(id, body.categoryId);
    }

    res.status(201).json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// PUT /transactions/manual/:id — update a manual transaction
const manualTxUpdateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().min(1).optional(),
  amount: z.number().optional(),
  cardLast4: z.string().nullable().optional(),
});

transactionsRouter.put('/transactions/manual/:id', (req, res, next) => {
  try {
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

  // INSERT for a transaction that doesn't exist yet (or a recycled-ID new row).
  const insertTx = db.prepare(`
    INSERT INTO transactions
      (id, provider_transaction_id, account_id, item_id, date, description, amount,
       amount_in_account_currency, currency_code, pluggy_category, pluggy_category_id,
       type, status, installment_number, total_installments, bill_id, card_last4,
       identity_hash, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // UPDATE only the mutable fields on a known-good existing row.
  // We deliberately do NOT update identity-stable fields (date, amount, description,
  // card_last4, installment_*) so that user-applied overrides remain attached
  // to the correct transaction even if Pluggy tweaks peripheral fields.
  const updateTx = db.prepare(`
    UPDATE transactions SET
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  // Look up the most-recently-inserted row for a given Pluggy ID.
  // ORDER BY first_seen_at DESC means that after a recycle (two rows with the
  // same provider_transaction_id), subsequent syncs match the newer row.
  const findByProviderId = db.prepare(`
    SELECT id, identity_hash, raw_json
    FROM transactions
    WHERE provider_transaction_id = ?
    ORDER BY first_seen_at DESC
    LIMIT 1
  `);

  // Fallback lookup by content hash — used when provider_transaction_id is
  // not found (e.g. bank reconnect where Pluggy issues new IDs for the same
  // physical card). Matches only pluggy-sourced rows to avoid colliding with
  // manual transactions that share a date/amount/slug.
  const findByIdentityHash = db.prepare(`
    SELECT id, identity_hash, raw_json
    FROM transactions
    WHERE identity_hash = ?
      AND source = 'pluggy'
    ORDER BY first_seen_at DESC
    LIMIT 1
  `);

  // Like updateTx but also records the new provider_transaction_id.
  // Used when a reconnect brings new Pluggy IDs for an existing transaction.
  const updateTxWithProvider = db.prepare(`
    UPDATE transactions SET
      provider_transaction_id = ?,
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  const insertConflict = db.prepare(`
    INSERT INTO transaction_sync_conflicts
      (provider_transaction_id, kept_transaction_id, new_transaction_id,
       old_payload_json, new_payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);

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

  const upsertTxBatch = db.transaction((txs: Transaction[], accountId: string) => {
    for (const t of txs) {
      const metadata: CreditCardMetadata | null = t.creditCardMetadata ?? null;
      const newDate = toYmd(t.date);
      const newPayload = JSON.stringify(t);
      const newHash = computeIdentityHash(newDate, t.amount, t.description ?? null);

      const existing = findByProviderId.get(t.id) as
        | { id: string; identity_hash: string | null; raw_json: string }
        | undefined;

      if (!existing) {
        // Provider ID not found — check by content hash (reconnect case).
        const existingByHash = findByIdentityHash.get(newHash) as
          | { id: string; identity_hash: string | null; raw_json: string }
          | undefined;
        if (existingByHash) {
          // Same purchase, new Pluggy connection — update with new provider ID.
          console.log(`[sync] Hash match for new provider ID ${t.id} — updating existing row ${existingByHash.id}`);
          updateTxWithProvider.run(t.id, t.status ?? null, metadata?.billId ?? null, newHash, newPayload, existingByHash.id);
        } else {
          // Brand-new transaction — insert fresh row.
          insertTx.run(
            randomUUID(), t.id, accountId, itemId, newDate,
            t.description ?? null, t.amount,
            t.amountInAccountCurrency ?? null, t.currencyCode ?? null,
            t.category ?? null, t.categoryId ?? null, t.type ?? null, t.status ?? null,
            metadata?.installmentNumber ?? null, metadata?.totalInstallments ?? null,
            metadata?.billId ?? null, lastFourDigits(metadata?.cardNumber),
            newHash, newPayload,
          );
        }
      } else if (existing.identity_hash === null || existing.identity_hash === newHash) {
        // Same transaction (or first sync after migration — hash was NULL).
        // Only update fields that Pluggy legitimately changes over time.
        updateTx.run(t.status ?? null, metadata?.billId ?? null, newHash, newPayload, existing.id);
      } else {
        // Recycled Pluggy ID: the incoming payload is a materially different
        // purchase. Keep the old row intact and insert the new one separately.
        const newLocalId = randomUUID();
        console.warn(
          `[sync] Recycled provider ID ${t.id}: existing identity ${existing.identity_hash} ` +
          `≠ incoming ${newHash}. Keeping old row, inserting new (${newLocalId}).`,
        );
        insertTx.run(
          newLocalId, t.id, accountId, itemId, newDate,
          t.description ?? null, t.amount,
          t.amountInAccountCurrency ?? null, t.currencyCode ?? null,
          t.category ?? null, t.categoryId ?? null, t.type ?? null, t.status ?? null,
          metadata?.installmentNumber ?? null, metadata?.totalInstallments ?? null,
          metadata?.billId ?? null, lastFourDigits(metadata?.cardNumber),
          newHash, newPayload,
        );
        insertConflict.run(t.id, existing.id, newLocalId, existing.raw_json, newPayload);
      }
      txCount++;
    }
  });

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

    // Transactions — fetch ALL pages for each account type.
    let page = 1;
    let totalPages = 1;
    do {
      const txPage = await pluggy.fetchTransactions(account.id, {
        pageSize: 500,
        page,
      });
      upsertTxBatch(txPage.results, account.id);
      totalPages = txPage.totalPages;
      page++;
    } while (page <= totalPages);
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
/**
 * Stable fingerprint for a transaction: SHA-256 of date + amount + merchant
 * slug. Used by sync to detect Pluggy ID recycling AND to deduplicate across
 * reconnects (same purchase, different Pluggy connection = new provider IDs
 * but same content hash).
 *
 * Account ID is intentionally excluded so the hash is portable across
 * reconnections where Pluggy assigns new account IDs for the same physical card.
 */
function computeIdentityHash(
  date: string,
  amount: number,
  description: string | null,
): string {
  const slug = extractMerchantSlug(description) ?? '';
  return createHash('sha256')
    .update(`${date}|${amount}|${slug}`)
    .digest('hex')
    .slice(0, 32);
}

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
