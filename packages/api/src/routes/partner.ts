import { Router } from 'express';
import { z } from 'zod';
import { partners, users } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { computeBillWindowAtOffset } from '../services/billWindow.js';

export const partnerRouter = Router();

// Resolve which other users share their credit-card splits with the logged-in
// viewer. The env var `USER_<OWNER>_PARTNER=<viewer>` declares the link;
// here we walk it in reverse to find every owner that targets the viewer.
function partnersFor(viewer: string): string[] {
  const out: string[] = [];
  for (const [owner, partner] of partners.entries()) {
    if (partner === viewer && users.has(owner)) out.push(owner);
  }
  return out;
}

interface AccountRow {
  id: string;
  item_id: string;
  name: string | null;
  number: string | null;
  type: string | null;
}

interface AccountSettingsRow {
  account_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
}

interface ItemRow {
  id: string;
  connector_name: string | null;
}

// GET /partner/cards — list every CREDIT account from every partner that
// shares with the viewer, plus the data needed to compute bill windows.
partnerRouter.get('/partner/cards', (req, res) => {
  const viewer = req.username;
  const owners = partnersFor(viewer);
  const out: Array<{
    ownerUsername: string;
    accountId: string;
    accountName: string | null;
    accountNumber: string | null;
    itemId: string;
    connectorName: string | null;
    displayName: string | null;
    closingDay: number;
    dueDay: number;
  }> = [];

  for (const owner of owners) {
    const db = getDb(owner);
    const accts = db
      .prepare(
        `SELECT a.id, a.item_id, a.name, a.number, a.type
         FROM accounts a
         WHERE a.type = 'CREDIT'`,
      )
      .all() as AccountRow[];
    for (const a of accts) {
      const s = db
        .prepare(
          `SELECT account_id, display_name, closing_day, due_day
           FROM account_settings WHERE account_id = ?`,
        )
        .get(a.id) as AccountSettingsRow | undefined;
      if (!s) continue; // unconfigured accounts can't compute bill windows
      const item = db
        .prepare('SELECT id, connector_name FROM items WHERE id = ?')
        .get(a.item_id) as ItemRow | undefined;
      out.push({
        ownerUsername: owner,
        accountId: a.id,
        accountName: a.name,
        accountNumber: a.number,
        itemId: a.item_id,
        connectorName: item?.connector_name ?? null,
        displayName: s.display_name,
        closingDay: s.closing_day,
        dueDay: s.due_day,
      });
    }
  }

  res.json(out);
});

// Shared bill view for a single partner-owned credit account at a given
// offset. Computes split totals from the OWNER's DB and exposes only what
// the viewer is owed (half/2 + theirs) plus a read-only transaction list.
const breakdownSchema = z.object({
  owner: z.string().min(1),
  accountId: z.string().min(1),
  offset: z.coerce.number().int().default(0),
});

partnerRouter.get('/partner/cards/breakdown', (req, res, next) => {
  try {
    const viewer = req.username;
    const { owner, accountId, offset } = breakdownSchema.parse(req.query);

    // Only allow reading from owners that have explicitly declared the viewer
    // as their partner. Anything else is a forbidden cross-tenant read.
    if (partners.get(owner) !== viewer || !users.has(owner)) {
      res.status(403).json({ error: 'NotYourPartner' });
      return;
    }

    const db = getDb(owner);

    const settings = db
      .prepare(
        `SELECT closing_day, due_day, display_name
         FROM account_settings WHERE account_id = ?`,
      )
      .get(accountId) as
      | { closing_day: number; due_day: number; display_name: string | null }
      | undefined;
    if (!settings) {
      res.status(404).json({ error: 'AccountNotFound' });
      return;
    }

    const account = db
      .prepare('SELECT id, item_id, name FROM accounts WHERE id = ?')
      .get(accountId) as { id: string; item_id: string; name: string | null } | undefined;
    if (!account) {
      res.status(404).json({ error: 'AccountNotFound' });
      return;
    }
    const item = db
      .prepare('SELECT connector_name FROM items WHERE id = ?')
      .get(account.item_id) as { connector_name: string | null } | undefined;

    const s = { closingDay: settings.closing_day, dueDay: settings.due_day };
    const current = computeBillWindowAtOffset(s, offset);
    const previous = computeBillWindowAtOffset(s, offset - 1);
    const next = computeBillWindowAtOffset(s, offset + 1);
    const prevPrev = computeBillWindowAtOffset(s, offset - 2);

    const totalForWindow = (
      cur: typeof current,
      prev: typeof previous,
      nxt: typeof next,
    ): { total: number; rows: SplitRow[] } => {
      const rows = readSplitRows(db, accountId, cur, prev, nxt);
      let total = 0;
      for (const r of rows) {
        const amt = Math.round(r.amount * 100) / 100;
        total += r.split_type === 'half' ? amt / 2 : amt;
      }
      return { total: round2(total), rows };
    };

    const cur = totalForWindow(current, previous, next);
    const prev = totalForWindow(previous, prevPrev, current);

    const transactions = cur.rows.map((r) => {
      const amt = Math.round(r.amount * 100) / 100;
      const owes =
        r.split_type === 'half'
          ? Math.round((r.amount / 2) * 100) / 100
          : amt;
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: amt,
        owes,
        splitType: r.split_type as 'half' | 'theirs',
        installmentNumber: r.installment_number,
        totalInstallments: r.total_installments,
        category:
          r.user_category_id != null
            ? {
                id: r.user_category_id,
                name: r.user_category_name!,
                color: r.user_category_color!,
              }
            : null,
      };
    });

    // Category breakdown — sum the *owed* portion per category, kept split
    // by half vs theirs so the Overview can show each separately. half +
    // theirs adds up to the headline total.
    const catMap = new Map<
      number,
      { id: number; name: string; color: string; halfTotal: number; theirsTotal: number }
    >();
    for (const r of cur.rows) {
      if (r.user_category_id == null) continue;
      const owed =
        r.split_type === 'half'
          ? Math.round((r.amount / 2) * 100) / 100
          : Math.round(r.amount * 100) / 100;
      const existing =
        catMap.get(r.user_category_id) ??
        {
          id: r.user_category_id,
          name: r.user_category_name!,
          color: r.user_category_color!,
          halfTotal: 0,
          theirsTotal: 0,
        };
      if (r.split_type === 'half') existing.halfTotal += owed;
      else existing.theirsTotal += owed;
      catMap.set(r.user_category_id, existing);
    }
    const categories = Array.from(catMap.values())
      .map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        halfTotal: round2(c.halfTotal),
        theirsTotal: round2(c.theirsTotal),
        total: round2(c.halfTotal + c.theirsTotal),
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      ownerUsername: owner,
      accountId,
      itemId: account.item_id,
      accountName: account.name,
      connectorName: item?.connector_name ?? null,
      displayName: settings.display_name,
      closingDay: settings.closing_day,
      dueDay: settings.due_day,
      offset,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      closingDate: current.nextClosingDate,
      dueDate: current.nextDueDate,
      total: cur.total,
      previousTotal: prev.total,
      delta: round2(cur.total - prev.total),
      categories,
      transactions,
    });
  } catch (err) {
    next(err);
  }
});

interface SplitRow {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  split_type: string;
  installment_number: number | null;
  total_installments: number | null;
  user_category_id: number | null;
  user_category_name: string | null;
  user_category_color: string | null;
}

function readSplitRows(
  db: Db,
  accountId: string,
  current: { periodStart: string; periodEnd: string },
  previous: { periodStart: string; periodEnd: string },
  next: { periodStart: string; periodEnd: string },
): SplitRow[] {
  return db
    .prepare(
      `SELECT t.id, t.date, t.description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              sp.split_type,
              t.installment_number, t.total_installments,
              uc.id    AS user_category_id,
              uc.name  AS user_category_name,
              uc.color AS user_category_color
       FROM transactions t
       INNER JOIN transaction_splits sp ON sp.transaction_id = t.id
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN user_categories       uc ON uc.id = tc.user_category_id
       LEFT JOIN transaction_hidden h ON h.transaction_id = t.id
       WHERE t.account_id = ?
         AND h.transaction_id IS NULL
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )
       ORDER BY t.date DESC, t.id DESC`,
    )
    .all(
      accountId,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as SplitRow[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
