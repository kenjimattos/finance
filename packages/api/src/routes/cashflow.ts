import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  computeBillWindowAtOffset,
  findOffsetForDueMonth,
} from '../services/billWindow.js';

export const cashflowRouter = Router();

/**
 * GET /cashflow/range — returns the first and last month that have BANK
 * transactions, so the frontend knows which months to render.
 */
cashflowRouter.get('/cashflow/range', (_req, res) => {
  const row = db
    .prepare(
      `SELECT MIN(t.date) AS first_date, MAX(t.date) AS last_date
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE a.type = 'BANK'`,
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
}

interface ManualEntryRow {
  id: number;
  description: string;
  amount: number;
  day_of_month: number;
}

interface CashFlowEntry {
  id: string;
  description: string;
  amount: number;
  type: 'bank_transaction' | 'manual_entry' | 'credit_card_bill';
  accountId?: string;
  bankAccountId?: string;
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
 * Descriptions to exclude from BANK transaction listings and sums.
 * These are internal bookkeeping entries from certain connectors
 * (e.g. PicPay's "Retirada de saldo por lastro") that duplicate
 * real movements and break balance calculations.
 */
const BANK_TX_EXCLUDE_DESCRIPTIONS = [
  'Retirada de saldo por lastro',
  'Recarga em carteira via Cartão de Crédito',
  'COM CARTAO',
];

const BANK_TX_EXCLUDE_SQL = BANK_TX_EXCLUDE_DESCRIPTIONS
  .map(() => "t.description NOT LIKE ?")
  .join(' AND ');

const BANK_TX_EXCLUDE_PARAMS = BANK_TX_EXCLUDE_DESCRIPTIONS.map((d) => `%${d}%`);

/**
 * GET /cashflow?month=YYYY-MM — day-by-day cash-flow view for a given month.
 *
 * Past days (up to yesterday): actual BANK transactions from Pluggy.
 * Future days (today onward): manual entries + credit card bill outflows.
 *
 * Opening balance = Pluggy's current balance minus all transactions from
 * the target month's first day through today. For past months everything
 * is "past"; for future months everything is "future".
 */
cashflowRouter.get('/cashflow', (req, res, next) => {
  try {
    const { month: monthParam } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
      .parse(req.query);

    const now = new Date();
    const realTodayDay = now.getDate();
    const realYear = now.getFullYear();
    const realMonth = now.getMonth() + 1;

    // Target month — from param or current month.
    const year = monthParam ? Number(monthParam.split('-')[0]) : realYear;
    const month = monthParam ? Number(monthParam.split('-')[1]) : realMonth;
    const monthDays = daysInMonth(year, month);

    const monthStr = `${year}-${pad(month)}`;
    const firstDay = `${monthStr}-01`;
    const lastDay = `${monthStr}-${pad(monthDays)}`;

    // "today" in the context of the target month:
    // - past month: today = day after last day (everything is past)
    // - current month: today = real today
    // - future month: today = 1st (everything is future)
    const realToday = `${realYear}-${pad(realMonth)}-${pad(realTodayDay)}`;
    const today = monthStr < `${realYear}-${pad(realMonth)}`
      ? `${monthStr}-${pad(monthDays + 1)}` // past month: everything is past
      : monthStr > `${realYear}-${pad(realMonth)}`
        ? `${monthStr}-01` // future month: everything is future
        : realToday; // current month: real today

    const todayDay = monthStr === `${realYear}-${pad(realMonth)}`
      ? realTodayDay
      : monthStr < `${realYear}-${pad(realMonth)}`
        ? monthDays + 1 // past: all days are "past"
        : 0; // future: no days are "past"

    // ── Find ALL BANK accounts ──
    const bankAccounts = db
      .prepare(
        "SELECT id, item_id, name, balance, subtype FROM accounts WHERE type = 'BANK'",
      )
      .all() as AccountRow[];

    const bankAccountIds = bankAccounts.map((a) => a.id);

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
               FROM transactions t
               WHERE t.account_id = ? AND t.date >= ? AND t.date <= ?
                 AND ${BANK_TX_EXCLUDE_SQL}`,
            )
            .get(ba.id, dayAfterSnap, dayBeforeFirst, ...BANK_TX_EXCLUDE_PARAMS) as { total: number };
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
             FROM transactions t
             WHERE t.account_id = ? AND t.date >= ? AND t.date <= ?
               AND ${BANK_TX_EXCLUDE_SQL}`,
          )
          .get(ba.id, firstDay, snapAfter.date, ...BANK_TX_EXCLUDE_PARAMS) as { total: number };
        opening = round2(snapAfter.balance - row.total);
      } else {
        // No snapshots at all — use live Pluggy balance (original fallback).
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(t.amount), 0) AS total
             FROM transactions t
             WHERE t.account_id = ? AND t.date >= ?
               AND ${BANK_TX_EXCLUDE_SQL}`,
          )
          .get(ba.id, firstDay, ...BANK_TX_EXCLUDE_PARAMS) as { total: number };
        opening = round2((ba.balance ?? 0) - row.total);
      }

      openingBalances.set(ba.id, opening);
    }

    // ── Past days: actual bank transactions (all bank accounts) ──
    let pastTxRows: BankTxRow[] = [];
    if (bankAccountIds.length > 0 && todayDay > 1) {
      const yesterday = `${monthStr}-${pad(todayDay - 1)}`;
      const placeholders = bankAccountIds.map(() => '?').join(',');
      pastTxRows = db
        .prepare(
          `SELECT t.id, t.account_id,  t.date,
                  COALESCE(o.description, t.description) AS description,
                  t.amount, t.type
           FROM transactions t
           LEFT JOIN transaction_description_overrides o ON o.transaction_id = t.id
           WHERE t.account_id IN (${placeholders})
             AND t.date >= ? AND t.date <= ?
             AND ${BANK_TX_EXCLUDE_SQL}
           ORDER BY t.date ASC, t.id ASC`,
        )
        .all(...bankAccountIds, firstDay, yesterday, ...BANK_TX_EXCLUDE_PARAMS) as BankTxRow[];
    }

    // ── Future days: manual entries ──
    const manualEntries = db
      .prepare('SELECT id, description, amount, day_of_month FROM manual_entries WHERE active = 1 AND month = ?')
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
      // Only include if due date falls in the future portion of the month.
      if (dueDay < todayDay) continue;

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
      const isPast = date < today;
      const entries: CashFlowEntry[] = [];

      if (isPast) {
        // Actual bank transactions for this day (all bank accounts).
        for (const tx of pastTxRows) {
          if (tx.date === date) {
            entries.push({
              id: tx.id,
              description: tx.description ?? '',
              amount: round2(tx.amount),
              type: 'bank_transaction',
              bankAccountId: tx.account_id,
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
