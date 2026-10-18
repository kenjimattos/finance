import { Router } from 'express';
import { z } from 'zod';
import { loadAccountCardSettings } from '../db/cardSettings.js';
import {
  computeBillWindowForCycle,
  offsetOfCycle,
  realignShiftsForSettingsChange,
  resolveCycleOverride,
} from '../services/billWindow.js';

export const cardSettingsRouter = Router();

const upsertSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  closingDay: z.number().int().min(1).max(28),
  dueDay: z.number().int().min(1).max(28),
});

// GET /account-settings/:accountId
cardSettingsRouter.get('/account-settings/:accountId', (req, res) => {
  const { db } = req;
  const row = db
    .prepare('SELECT * FROM account_settings WHERE account_id = ?')
    .get(req.params.accountId);
  if (!row) {
    res.status(404).json({ error: 'NotFound' });
    return;
  }
  res.json(row);
});

// PUT /account-settings/:accountId
cardSettingsRouter.put('/account-settings/:accountId', (req, res, next) => {
  try {
    const { db } = req;
    const body = upsertSchema.parse(req.body);
    const { accountId } = req.params;

    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
    if (!account) {
      res.status(404).json({ error: 'AccountNotFound' });
      return;
    }

    db.prepare(
      `INSERT INTO account_settings (account_id, display_name, closing_day, due_day, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         display_name = excluded.display_name,
         closing_day  = excluded.closing_day,
         due_day      = excluded.due_day,
         updated_at   = datetime('now')`,
    ).run(accountId, body.displayName ?? null, body.closingDay, body.dueDay);

    const row = db
      .prepare('SELECT * FROM account_settings WHERE account_id = ?')
      .get(accountId);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// A real calendar date: the regex alone would accept 2026-02-31.
const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'invalid date');

const cycleOverrideSchema = z.object({
  closingDate: ymdSchema.nullable(),
  dueDate: ymdSchema.nullable(),
});

// PUT /account-settings/:accountId/cycles/:cycleMonth { closingDate, dueDate }
//
// Override one bill's closing and/or due date. null keeps (or restores) the
// default from account_settings; both null removes the override. Bill shifts
// whose natural cycle moves with the boundary are realigned in the same
// transaction so every shifted row stays on the bill the user put it on.
cardSettingsRouter.put('/account-settings/:accountId/cycles/:cycleMonth', (req, res, next) => {
  try {
    const { db } = req;
    const { accountId } = req.params;
    const cycleMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.params.cycleMonth);
    const body = cycleOverrideSchema.parse(req.body);

    const before = loadAccountCardSettings(db, accountId);
    if (!before) {
      res.status(404).json({ error: 'AccountSettingsMissing' });
      return;
    }
    const [y, m] = cycleMonth.split('-').map(Number);
    const resolved = resolveCycleOverride(before, y, m, body);
    if (!resolved.ok) {
      res.status(400).json({ error: resolved.error, message: resolved.message });
      return;
    }
    const { closingDate, dueDate } = resolved;

    const today = new Date();
    const result = db.transaction(() => {
      if (closingDate === null && dueDate === null) {
        db.prepare('DELETE FROM bill_cycle_overrides WHERE account_id = ? AND cycle_month = ?').run(
          accountId,
          cycleMonth,
        );
      } else {
        db.prepare(
          `INSERT INTO bill_cycle_overrides (account_id, cycle_month, closing_date, due_date, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(account_id, cycle_month) DO UPDATE SET
             closing_date = excluded.closing_date,
             due_date     = excluded.due_date,
             updated_at   = datetime('now')`,
        ).run(accountId, cycleMonth, closingDate, dueDate);
      }

      const after = loadAccountCardSettings(db, accountId)!;
      const shifted = db
        .prepare(
          `SELECT id, date, bill_shift AS shift FROM transactions
           WHERE account_id = ? AND bill_shift IS NOT NULL`,
        )
        .all(accountId) as Array<{ id: string; date: string; shift: number }>;
      const changes = realignShiftsForSettingsChange(before, after, shifted, today);
      const setShift = db.prepare('UPDATE transactions SET bill_shift = ? WHERE id = ?');
      for (const c of changes) setShift.run(c.shift, c.id);

      return {
        window: computeBillWindowForCycle(after, y, m),
        // An earlier closing can close the open bill (or a later one reopen
        // it), so the edited cycle's offset may change; the client follows it.
        offset: offsetOfCycle(after, cycleMonth, today),
        realignedShifts: changes.length,
      };
    })();

    res.json({
      cycleMonth,
      closingDate: result.window.nextClosingDate,
      dueDate: result.window.nextDueDate,
      closingOverridden: result.window.closingOverridden,
      dueOverridden: result.window.dueOverridden,
      offset: result.offset,
      realignedShifts: result.realignedShifts,
    });
  } catch (err) {
    next(err);
  }
});
