import { Router } from 'express';
import { db } from '../db/index.js';
import {
  computeBillWindowAtOffset,
  findOffsetForDueMonth,
} from '../services/billWindow.js';

export const cashflowRouter = Router();

interface AccountRow {
  id: string;
  item_id: string;
  name: string | null;
  balance: number | null;
  subtype: string | null;
}

interface AccountSettingsRow {
  account_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
}

interface BankTxRow {
  id: string;
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

/**
 * GET /cashflow — day-by-day cash-flow view for the current month.
 *
 * Past days (up to yesterday): actual BANK transactions from Pluggy.
 * Future days (today onward): manual entries + credit card bill outflows.
 */
cashflowRouter.get('/cashflow', (_req, res, next) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-based
    const todayDay = now.getDate();
    const monthDays = daysInMonth(year, month);

    const monthStr = `${year}-${pad(month)}`;
    const firstDay = `${monthStr}-01`;
    const lastDay = `${monthStr}-${pad(monthDays)}`;
    const today = `${monthStr}-${pad(todayDay)}`;

    // ── Find BANK account ──
    const bankAccount = db
      .prepare(
        "SELECT id, item_id, name, balance, subtype FROM accounts WHERE type = 'BANK' LIMIT 1",
      )
      .get() as AccountRow | undefined;

    // ── Past days: actual bank transactions ──
    let pastTxRows: BankTxRow[] = [];
    if (bankAccount && todayDay > 1) {
      const yesterday = `${monthStr}-${pad(todayDay - 1)}`;
      pastTxRows = db
        .prepare(
          `SELECT t.id, t.date,
                  COALESCE(o.description, t.description) AS description,
                  t.amount, t.type
           FROM transactions t
           LEFT JOIN transaction_description_overrides o ON o.transaction_id = t.id
           WHERE t.account_id = ?
             AND t.date >= ? AND t.date <= ?
           ORDER BY t.date ASC, t.id ASC`,
        )
        .all(bankAccount.id, firstDay, yesterday) as BankTxRow[];
    }

    // ── Future days: manual entries ──
    const manualEntries = db
      .prepare('SELECT id, description, amount, day_of_month FROM manual_entries WHERE active = 1')
      .all() as ManualEntryRow[];

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
        // Actual bank transactions for this day.
        for (const tx of pastTxRows) {
          if (tx.date === date) {
            entries.push({
              id: tx.id,
              description: tx.description ?? '',
              amount: round2(tx.amount),
              type: 'bank_transaction',
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
      bankAccount: bankAccount
        ? { id: bankAccount.id, name: bankAccount.name, balance: bankAccount.balance }
        : null,
      days,
    });
  } catch (err) {
    next(err);
  }
});
