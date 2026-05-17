import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from 'pluggy-sdk';
import { pluggy } from '../services/pluggy.js';
import {
  computeBillWindowAtOffset,
  findOffsetForDueMonth,
} from '../services/billWindow.js';

export const cashflowRouter = Router();

/**
 * GET /cashflow/range — returns the first and last month that have BANK
 * transactions, so the frontend knows which months to render.
 */
cashflowRouter.get('/cashflow/range', (req, res) => {
  const { db } = req;
  const row = db
    .prepare(
      `SELECT MIN(date) AS first_date, MAX(date) AS last_date
       FROM bank_transactions`,
    )
    .get() as { first_date: string | null; last_date: string | null };

  if (!row?.first_date || !row?.last_date) {
    res.json({ firstMonth: null, lastMonth: null });
    return;
  }

  // Extract YYYY-MM from the date strings.
  res.json({
    firstMonth: row.first_date.slice(0, 7),
    lastMonth: row.last_date.slice(0, 7),
  });
});

/**
 * PUT /cashflow/bill-tag/:transactionId — tag a bank transaction as a bill payment.
 * DELETE /cashflow/bill-tag/:transactionId — remove the tag.
 */
cashflowRouter.put('/cashflow/bill-tag/:transactionId', (req, res) => {
  const { db } = req;
  const { transactionId } = req.params;
  db.prepare(
    `INSERT OR IGNORE INTO bank_bill_payment_tags (transaction_id) VALUES (?)`,
  ).run(transactionId);
  res.json({ ok: true, transactionId, tagged: true });
});

cashflowRouter.delete('/cashflow/bill-tag/:transactionId', (req, res) => {
  const { db } = req;
  const { transactionId } = req.params;
  db.prepare('DELETE FROM bank_bill_payment_tags WHERE transaction_id = ?').run(transactionId);
  res.json({ ok: true, transactionId, tagged: false });
});

/**
 * PUT /cashflow/hide/:transactionId — exclude this row from the CashFlow view
 *   (used for known visual duplicates: the bank reported the same charge twice
 *   under different provider_ids).
 * DELETE /cashflow/hide/:transactionId — un-hide.
 */
cashflowRouter.put('/cashflow/hide/:transactionId', (req, res) => {
  const { db } = req;
  const { transactionId } = req.params;
  db.prepare(
    'INSERT OR IGNORE INTO bank_transaction_hidden (transaction_id) VALUES (?)',
  ).run(transactionId);
  res.json({ ok: true, transactionId, hidden: true });
});

cashflowRouter.delete('/cashflow/hide/:transactionId', (req, res) => {
  const { db } = req;
  const { transactionId } = req.params;
  db.prepare('DELETE FROM bank_transaction_hidden WHERE transaction_id = ?').run(transactionId);
  res.json({ ok: true, transactionId, hidden: false });
});

/**
 * PUT  /bank-transactions/:id/description — override a bank transaction's display description.
 * DELETE /bank-transactions/:id/description — clear the override.
 */
cashflowRouter.put('/bank-transactions/:id/description', (req, res, next) => {
  try {
    const { db } = req;
    const txId = req.params.id;
    const { description } = z
      .object({ description: z.string().min(1) })
      .parse(req.body);

    const tx = db.prepare('SELECT id FROM bank_transactions WHERE id = ?').get(txId);
    if (!tx) {
      res.status(404).json({ error: 'Bank transaction not found' });
      return;
    }

    db.prepare(
      `INSERT INTO bank_transaction_description_overrides (transaction_id, description)
       VALUES (?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET description = excluded.description`,
    ).run(txId, description);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /bank-transactions/:id/sort-key — set/clear the manual ordering key.
 * Body: { sortKey: number | null }. Null restores natural order.
 */
cashflowRouter.put('/bank-transactions/:id/sort-key', (req, res, next) => {
  try {
    const { db } = req;
    const txId = req.params.id;
    const { sortKey } = z
      .object({ sortKey: z.number().nullable() })
      .parse(req.body);

    const tx = db.prepare('SELECT id FROM bank_transactions WHERE id = ?').get(txId);
    if (!tx) {
      res.status(404).json({ error: 'Bank transaction not found' });
      return;
    }

    db.prepare('UPDATE bank_transactions SET sort_key = ? WHERE id = ?').run(sortKey, txId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

cashflowRouter.delete('/bank-transactions/:id/description', (req, res, next) => {
  try {
    const { db } = req;
    const txId = req.params.id;
    db.prepare(
      'DELETE FROM bank_transaction_description_overrides WHERE transaction_id = ?',
    ).run(txId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

interface AccountRow {
  id: string;
  item_id: string;
  name: string | null;
  balance: number | null;
  subtype: string | null;
}

interface BankTxRow {
  id: string;
  account_id: string;
  date: string;
  description: string | null;
  amount: number;
  type: string | null;
  is_bill_tagged: number;
  sort_key: number | null;
}

interface ManualEntryRow {
  id: number;
  description: string;
  amount: number;
  day_of_month: number;
  sort_key: number | null;
}

interface CashFlowEntry {
  id: string;
  description: string;
  amount: number;
  type: 'bank_transaction' | 'manual_entry' | 'credit_card_bill';
  accountId?: string;
  bankAccountId?: string;
  isBillPayment?: boolean;
}

interface CashFlowDay {
  date: string;
  isPast: boolean;
  entries: CashFlowEntry[];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * BANK transactions are excluded from listings and sums only when the user
 * has explicitly hidden them via `bank_transaction_hidden`. There is no
 * description-based blocklist: connector noise (e.g. PicPay's
 * "Recarga em carteira" / "Retirada de saldo por lastro" trios) can't be
 * pattern-matched safely — the "real spend" leg of such a trio has a
 * per-recipient description with no stable string to match — so the user
 * hides those rows by hand instead.
 */
const BANK_TX_NOT_HIDDEN_SQL =
  "NOT EXISTS (SELECT 1 FROM bank_transaction_hidden h WHERE h.transaction_id = t.id)";

/**
 * GET /cashflow?month=YYYY-MM — day-by-day cash-flow view for a given month.
 *
 * Days covered by real data (up to last bank transaction date): actual
 * BANK transactions from Pluggy. Days beyond that: manual entries +
 * credit card bill outflows. The boundary is data-driven, not tied to
 * today's date.
 */
cashflowRouter.get('/cashflow', (req, res, next) => {
  try {
    const { db } = req;
    const { month: monthParam } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
      .parse(req.query);

    const now = new Date();
    const realYear = now.getFullYear();
    const realMonth = now.getMonth() + 1;

    // Target month — from param or current month.
    const year = monthParam ? Number(monthParam.split('-')[0]) : realYear;
    const month = monthParam ? Number(monthParam.split('-')[1]) : realMonth;
    const monthDays = daysInMonth(year, month);

    const monthStr = `${year}-${pad(month)}`;
    const firstDay = `${monthStr}-01`;
    const lastDay = `${monthStr}-${pad(monthDays)}`;

    // ── Find ALL BANK accounts ──
    const bankAccounts = db
      .prepare(
        "SELECT id, item_id, name, balance, subtype FROM accounts WHERE type = 'BANK'",
      )
      .all() as AccountRow[];

    const bankAccountIds = bankAccounts.map((a) => a.id);

    // ── Data coverage boundary ──
    // One global cutoff: the latest date that has ANY real bank transaction,
    // across every account and every month. Hidden rows still count — hiding
    // is a display choice, not "data ends here". Days on or before this date
    // are realized (show real bank transactions); days after it are
    // projection territory (manual entries + credit card bill outflows).
    // Deliberately NOT tied to today's date: if syncing stalls, the boundary
    // stalls with it, instead of marking un-synced days as empty-but-realized.
    const realizedRow = db
      .prepare('SELECT MAX(date) AS max_date FROM bank_transactions')
      .get() as { max_date: string | null };
    const lastRealizedDate = realizedRow.max_date ?? '0000-00-00';

    // ── Compute opening balance per bank account ──
    // Find the best anchor: the closest balance snapshot to the target month.
    // If the snapshot is AFTER firstDay: opening = snap − sum(firstDay..snap)
    // If the snapshot is BEFORE firstDay: opening = snap + sum(snap+1..day before firstDay)
    // Falls back to the live Pluggy balance when no snapshots exist.
    const openingBalances = new Map<string, number>();
    for (const ba of bankAccounts) {
      // Try nearest snapshot AFTER (or on) firstDay, then nearest BEFORE.
      const snapAfter = db
        .prepare(
          `SELECT date, balance FROM balance_snapshots
           WHERE account_id = ? AND date >= ?
           ORDER BY date ASC LIMIT 1`,
        )
        .get(ba.id, firstDay) as { date: string; balance: number } | undefined;

      const snapBefore = db
        .prepare(
          `SELECT date, balance FROM balance_snapshots
           WHERE account_id = ? AND date < ?
           ORDER BY date DESC LIMIT 1`,
        )
        .get(ba.id, firstDay) as { date: string; balance: number } | undefined;

      let opening: number;

      if (snapBefore) {
        // Snapshot is before firstDay — roll forward:
        // opening = snap.balance + sum(transactions from snap.date+1 to day before firstDay)
        // But since there are no transactions between end-of-prev-month and firstDay
        // in practice, and the snapshot IS end-of-day, we need transactions from
        // day after snapshot through day before firstDay.
        const dayAfterSnap = addDaysIso(snapBefore.date, 1);
        const dayBeforeFirst = addDaysIso(firstDay, -1);
        if (dayAfterSnap <= dayBeforeFirst) {
          const row = db
            .prepare(
              `SELECT COALESCE(SUM(t.amount), 0) AS total
               FROM bank_transactions t
               WHERE t.account_id = ? AND t.date >= ? AND t.date <= ?
                 AND ${BANK_TX_NOT_HIDDEN_SQL}`,
            )
            .get(ba.id, dayAfterSnap, dayBeforeFirst) as { total: number };
          opening = round2(snapBefore.balance + row.total);
        } else {
          // Snapshot is the day before firstDay — balance IS the opening.
          opening = snapBefore.balance;
        }
      } else if (snapAfter) {
        // Snapshot is on or after firstDay — roll backward:
        // opening = snap.balance − sum(transactions from firstDay through snap.date)
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(t.amount), 0) AS total
             FROM bank_transactions t
             WHERE t.account_id = ? AND t.date >= ? AND t.date <= ?
               AND ${BANK_TX_NOT_HIDDEN_SQL}`,
          )
          .get(ba.id, firstDay, snapAfter.date) as { total: number };
        opening = round2(snapAfter.balance - row.total);
      } else {
        // No snapshots at all — use live Pluggy balance (original fallback).
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(t.amount), 0) AS total
             FROM bank_transactions t
             WHERE t.account_id = ? AND t.date >= ?
               AND ${BANK_TX_NOT_HIDDEN_SQL}`,
          )
          .get(ba.id, firstDay) as { total: number };
        opening = round2((ba.balance ?? 0) - row.total);
      }

      openingBalances.set(ba.id, opening);
    }

    // ── Realized days: actual bank transactions (all bank accounts) ──
    // Every bank transaction is realized by definition (its date is <=
    // lastRealizedDate), so the whole month window is fair game — the
    // assembly loop below places each row on its own day.
    let pastTxRows: BankTxRow[] = [];
    if (bankAccountIds.length > 0) {
      const placeholders = bankAccountIds.map(() => '?').join(',');
      pastTxRows = db
        .prepare(
          `SELECT t.id, t.account_id,  t.date,
                  COALESCE(o.description, t.description) AS description,
                  t.amount, t.type, t.sort_key,
                  CASE WHEN bp.transaction_id IS NOT NULL THEN 1 ELSE 0 END AS is_bill_tagged
           FROM bank_transactions t
           LEFT JOIN bank_transaction_description_overrides o ON o.transaction_id = t.id
           LEFT JOIN bank_bill_payment_tags bp ON bp.transaction_id = t.id
           WHERE t.account_id IN (${placeholders})
             AND t.date >= ? AND t.date <= ?
             AND ${BANK_TX_NOT_HIDDEN_SQL}
           ORDER BY t.date ASC, COALESCE(t.sort_key, 1e18) ASC, t.id ASC`,
        )
        .all(...bankAccountIds, firstDay, lastDay) as BankTxRow[];
    }

    // ── Future days: manual entries ──
    const manualEntries = db
      .prepare(
        `SELECT id, description, amount, day_of_month, sort_key
         FROM manual_entries
         WHERE active = 1 AND month = ?
         ORDER BY day_of_month ASC, COALESCE(sort_key, id * 1.0) ASC, id ASC`,
      )
      .all(monthStr) as ManualEntryRow[];

    // ── Future days: credit card bill outflows ──
    const creditAccounts = db
      .prepare(
        `SELECT a.id AS account_id, s.display_name, s.closing_day, s.due_day
         FROM accounts a
         INNER JOIN account_settings s ON s.account_id = a.id
         WHERE a.type = 'CREDIT'`,
      )
      .all() as Array<{
      account_id: string;
      display_name: string | null;
      closing_day: number;
      due_day: number;
    }>;

    const billEntries: Array<{ day: number; entry: CashFlowEntry }> = [];

    for (const acct of creditAccounts) {
      const settings = { closingDay: acct.closing_day, dueDay: acct.due_day };
      const offset = findOffsetForDueMonth(settings, year, month);
      if (offset === null) continue;

      const dueDay = acct.due_day;
      // Only project the bill if its due date is still ahead of the last
      // realized bank transaction. Once real data has moved past the due
      // date, the actual "Pagamento de fatura" bank row represents it —
      // projecting it again would double-count.
      const dueDate = `${monthStr}-${pad(Math.min(dueDay, monthDays))}`;
      if (dueDate <= lastRealizedDate) continue;

      // Compute bill total using the same shift-aware logic as bills.ts.
      const current = computeBillWindowAtOffset(settings, offset);
      const previous = computeBillWindowAtOffset(settings, offset - 1);
      const next = computeBillWindowAtOffset(settings, offset + 1);

      const row = db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(t.amount_in_account_currency, t.amount)), 0) AS total
           FROM transactions t
           INNER JOIN transaction_categories tc ON tc.transaction_id = t.id
           LEFT JOIN transaction_bill_overrides bo ON bo.transaction_id = t.id
           WHERE t.account_id = ?
             AND (
                  (bo.shift IS NULL AND t.date >= ? AND t.date <= ?)
               OR (bo.shift = 1     AND t.date >= ? AND t.date <= ?)
               OR (bo.shift = -1    AND t.date >= ? AND t.date <= ?)
             )`,
        )
        .get(
          acct.account_id,
          current.periodStart, current.periodEnd,
          previous.periodStart, previous.periodEnd,
          next.periodStart, next.periodEnd,
        ) as { total: number };

      if (row.total === 0) continue;

      const label = acct.display_name
        ? `Fatura ${acct.display_name}`
        : 'Fatura cartão';

      billEntries.push({
        day: Math.min(dueDay, monthDays),
        entry: {
          id: `bill-${acct.account_id}`,
          description: label,
          amount: round2(-row.total), // bill total is positive spend → outflow is negative
          type: 'credit_card_bill',
          accountId: acct.account_id,
        },
      });
    }

    // ── Assemble day-by-day timeline ──
    const days: CashFlowDay[] = [];

    for (let d = 1; d <= monthDays; d++) {
      const date = `${monthStr}-${pad(d)}`;
      const isPast = date <= lastRealizedDate;
      const entries: CashFlowEntry[] = [];

      if (isPast) {
        // Actual bank transactions for this day (all bank accounts).
        for (const tx of pastTxRows) {
          if (tx.date === date) {
            const billTagged = tx.is_bill_tagged === 1;
            entries.push({
              id: tx.id,
              description: tx.description ?? '',
              amount: round2(tx.amount),
              type: 'bank_transaction',
              bankAccountId: tx.account_id,
              isBillPayment: billTagged || undefined,
            });
          }
        }
      } else {
        // Manual entries whose day_of_month matches (clamped).
        for (const me of manualEntries) {
          const clampedDay = Math.min(me.day_of_month, monthDays);
          if (clampedDay === d) {
            entries.push({
              id: `manual-${me.id}`,
              description: me.description,
              amount: round2(me.amount),
              type: 'manual_entry',
            });
          }
        }

        // Credit card bill outflows on their due day.
        for (const bill of billEntries) {
          if (bill.day === d) {
            entries.push(bill.entry);
          }
        }
      }

      // Only include days that have entries (keeps the response lean).
      if (entries.length > 0) {
        days.push({ date, isPast, entries });
      }
    }

    res.json({
      month: monthStr,
      bankAccounts: bankAccounts.map((ba) => ({
        id: ba.id,
        name: ba.name,
        balance: ba.balance,
        openingBalance: openingBalances.get(ba.id) ?? null,
      })),
      days,
    });
  } catch (err) {
    next(err);
  }
});

// ── Helpers for sync ──

function toYmd(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * POST /cashflow/sync — sync BANK accounts and their transactions into
 * `bank_transactions`. The sync logic is intentionally naive:
 *   - if Pluggy returns a `provider_transaction_id` we have already seen,
 *     overwrite every mutable field on that row (date, description, amount,
 *     status, raw_json);
 *   - otherwise insert a new row.
 *
 * No identity_hash, no "recycled ID" heuristic. We treat Pluggy's
 * provider_transaction_id as authoritative for BANK because we have not
 * observed it being recycled, and the previous heuristic (date+amount+slug
 * hash) caused false positives when Pluggy enriched descriptions between
 * syncs. If a real recycle ever happens, the new payload simply overwrites
 * the old row — we will see it in the data and react then.
 */
cashflowRouter.post('/cashflow/sync', async (req, res, next) => {
  try {
    const { db } = req;
    const items = db
      .prepare('SELECT id FROM items')
      .all() as Array<{ id: string }>;

    let txCount = 0;

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

    const snapshotBalance = db.prepare(`
      INSERT INTO balance_snapshots (account_id, date, balance)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id, date) DO UPDATE SET
        balance = excluded.balance,
        created_at = datetime('now')
    `);

    const insertTx = db.prepare(`
      INSERT INTO bank_transactions
        (id, provider_transaction_id, account_id, item_id, date, description, amount,
         currency_code, pluggy_category, pluggy_category_id, type, status, raw_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const updateTxByProviderId = db.prepare(`
      UPDATE bank_transactions SET
        date         = ?,
        description  = ?,
        amount       = ?,
        status       = ?,
        last_seen_at = datetime('now'),
        raw_json     = ?,
        synced_at    = datetime('now')
      WHERE id = ?
    `);

    const findByProviderId = db.prepare(`
      SELECT id FROM bank_transactions
      WHERE provider_transaction_id = ?
      LIMIT 1
    `);

    const upsertTxBatch = db.transaction((txs: Transaction[], accountId: string, itemId: string) => {
      for (const t of txs) {
        const newDate = toYmd(t.date);
        const newPayload = JSON.stringify(t);

        const existing = findByProviderId.get(t.id) as { id: string } | undefined;

        if (existing) {
          updateTxByProviderId.run(
            newDate, t.description ?? null, t.amount, t.status ?? null,
            newPayload, existing.id,
          );
        } else {
          insertTx.run(
            randomUUID(), t.id, accountId, itemId, newDate,
            t.description ?? null, t.amount, t.currencyCode ?? null,
            t.category ?? null, t.categoryId ?? null, t.type ?? null, t.status ?? null,
            newPayload,
          );
        }
        txCount++;
      }
    });

    const now = new Date();
    const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    for (const item of items) {
      let bankAccounts: Awaited<ReturnType<typeof pluggy.fetchAccounts>>['results'] = [];
      try {
        const r = await pluggy.fetchAccounts(item.id, 'BANK');
        bankAccounts = r.results;
      } catch {
        continue; // item may not have bank accounts
      }

      for (const account of bankAccounts) {
        upsertAccount.run(
          account.id, item.id,
          account.name ?? null, account.number ?? null,
          account.type ?? null, account.subtype ?? null,
          account.balance ?? null, JSON.stringify(account),
        );

        if (account.balance != null) {
          snapshotBalance.run(account.id, todayYmd, account.balance);
        }

        let page = 1;
        let totalPages = 1;
        do {
          const txPage = await pluggy.fetchTransactions(account.id, {
            pageSize: 500,
            page,
          });
          upsertTxBatch(txPage.results, account.id, item.id);
          totalPages = txPage.totalPages;
          page++;
        } while (page <= totalPages);
      }
    }

    res.json({ ok: true, transactions: txCount });
  } catch (err) {
    next(err);
  }
});
