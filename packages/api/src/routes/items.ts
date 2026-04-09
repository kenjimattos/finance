import { Router } from 'express';
import { z } from 'zod';
import { pluggy } from '../services/pluggy.js';
import { db } from '../db/index.js';

export const itemsRouter = Router();

// GET /items — list locally saved items (connections the user has linked)
itemsRouter.get('/items', (_req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  res.json(rows);
});

// POST /items — persist an itemId returned from the Pluggy Connect widget
const saveItemSchema = z.object({ itemId: z.string().min(1) });

itemsRouter.post('/items', async (req, res, next) => {
  try {
    const { itemId } = saveItemSchema.parse(req.body);

    // Validate with Pluggy and grab the connector name for display
    const item = await pluggy.fetchItem(itemId);

    db.prepare(
      'INSERT OR REPLACE INTO items (id, connector_name) VALUES (?, ?)',
    ).run(item.id, item.connector?.name ?? null);

    res.status(201).json({ id: item.id, connectorName: item.connector?.name });
  } catch (err) {
    next(err);
  }
});
