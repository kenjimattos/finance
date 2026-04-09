import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { pickNextColor } from '../services/categoryColors.js';

export const categoriesRouter = Router();

const nameSchema = z.object({ name: z.string().min(1).max(40).trim() });

// GET /categories — list with usage_count, most used first
categoriesRouter.get('/categories', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, color, usage_count, created_at
       FROM user_categories
       ORDER BY usage_count DESC, name ASC`,
    )
    .all();
  res.json(rows);
});

// POST /categories — creates a new category with an auto-assigned color
categoriesRouter.post('/categories', (req, res, next) => {
  try {
    const { name } = nameSchema.parse(req.body);
    const existing = db
      .prepare('SELECT color FROM user_categories')
      .all() as Array<{ color: string }>;
    const color = pickNextColor(existing.map((r) => r.color));

    try {
      const info = db
        .prepare('INSERT INTO user_categories (name, color) VALUES (?, ?)')
        .run(name, color);
      const row = db
        .prepare('SELECT * FROM user_categories WHERE id = ?')
        .get(info.lastInsertRowid);
      res.status(201).json(row);
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'CategoryAlreadyExists' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// PUT /categories/:id — rename (color is not user-editable in V1)
categoriesRouter.put('/categories/:id', (req, res, next) => {
  try {
    const { name } = nameSchema.parse(req.body);
    const info = db
      .prepare('UPDATE user_categories SET name = ? WHERE id = ?')
      .run(name, req.params.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'NotFound' });
      return;
    }
    const row = db
      .prepare('SELECT * FROM user_categories WHERE id = ?')
      .get(req.params.id);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// DELETE /categories/:id — cascades to transaction_categories and category_rules
categoriesRouter.delete('/categories/:id', (req, res) => {
  const info = db
    .prepare('DELETE FROM user_categories WHERE id = ?')
    .run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'NotFound' });
    return;
  }
  res.status(204).send();
});
