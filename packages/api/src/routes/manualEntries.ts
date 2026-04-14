import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';

export const manualEntriesRouter = Router();

interface ManualEntryRow {
  id: number;
  description: string;
  amount: number;
  day_of_month: number;
  month: string;
  active: number;
  created_at: string;
}

function toResponse(row: ManualEntryRow) {
  return {
    id: row.id,
    description: row.description,
    amount: row.amount,
    dayOfMonth: row.day_of_month,
    month: row.month,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

// GET /manual-entries?month=YYYY-MM — list entries for a specific month
manualEntriesRouter.get('/manual-entries', (req, res, next) => {
  try {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() })
      .parse(req.query);

    const rows = month
      ? db
          .prepare('SELECT * FROM manual_entries WHERE month = ? ORDER BY day_of_month ASC')
          .all(month) as ManualEntryRow[]
      : db
          .prepare('SELECT * FROM manual_entries ORDER BY month ASC, day_of_month ASC')
          .all() as ManualEntryRow[];
    res.json(rows.map(toResponse));
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  description: z.string().min(1),
  amount: z.number(),
  dayOfMonth: z.number().int().min(1).max(31),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

// POST /manual-entries — create a new entry for a specific month
manualEntriesRouter.post('/manual-entries', (req, res, next) => {
  try {
    const { description, amount, dayOfMonth, month } = createSchema.parse(req.body);
    const result = db
      .prepare(
        'INSERT INTO manual_entries (description, amount, day_of_month, month) VALUES (?, ?, ?, ?)',
      )
      .run(description, amount, dayOfMonth, month);
    const row = db
      .prepare('SELECT * FROM manual_entries WHERE id = ?')
      .get(result.lastInsertRowid) as ManualEntryRow;
    res.status(201).json(toResponse(row));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  description: z.string().min(1).optional(),
  amount: z.number().optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  active: z.boolean().optional(),
});

// PUT /manual-entries/:id — update an entry
manualEntriesRouter.put('/manual-entries/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const updates = updateSchema.parse(req.body);

    const existing = db
      .prepare('SELECT * FROM manual_entries WHERE id = ?')
      .get(id) as ManualEntryRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const sets: string[] = [];
    const vals: (string | number)[] = [];

    if (updates.description !== undefined) {
      sets.push('description = ?');
      vals.push(updates.description);
    }
    if (updates.amount !== undefined) {
      sets.push('amount = ?');
      vals.push(updates.amount);
    }
    if (updates.dayOfMonth !== undefined) {
      sets.push('day_of_month = ?');
      vals.push(updates.dayOfMonth);
    }
    if (updates.active !== undefined) {
      sets.push('active = ?');
      vals.push(updates.active ? 1 : 0);
    }

    if (sets.length > 0) {
      vals.push(id);
      db.prepare(`UPDATE manual_entries SET ${sets.join(', ')} WHERE id = ?`).run(
        ...vals,
      );
    }

    const row = db
      .prepare('SELECT * FROM manual_entries WHERE id = ?')
      .get(id) as ManualEntryRow;
    res.json(toResponse(row));
  } catch (err) {
    next(err);
  }
});

// DELETE /manual-entries/:id — remove an entry
manualEntriesRouter.delete('/manual-entries/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = db
      .prepare('DELETE FROM manual_entries WHERE id = ?')
      .run(id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
