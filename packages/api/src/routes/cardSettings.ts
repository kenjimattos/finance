import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';

export const cardSettingsRouter = Router();

const upsertSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  closingDay: z.number().int().min(1).max(28),
  dueDay: z.number().int().min(1).max(28),
});

// GET /card-settings/:itemId
cardSettingsRouter.get('/card-settings/:itemId', (req, res) => {
  const row = db
    .prepare('SELECT * FROM card_settings WHERE item_id = ?')
    .get(req.params.itemId);
  if (!row) {
    res.status(404).json({ error: 'NotFound' });
    return;
  }
  res.json(row);
});

// PUT /card-settings/:itemId — upsert closing/due configuration for a card
cardSettingsRouter.put('/card-settings/:itemId', (req, res, next) => {
  try {
    const body = upsertSchema.parse(req.body);
    const { itemId } = req.params;

    // Verify item exists (FK would also reject, but a clean 404 is nicer)
    const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
    if (!item) {
      res.status(404).json({ error: 'ItemNotFound' });
      return;
    }

    db.prepare(
      `INSERT INTO card_settings (item_id, display_name, closing_day, due_day, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(item_id) DO UPDATE SET
         display_name = excluded.display_name,
         closing_day  = excluded.closing_day,
         due_day      = excluded.due_day,
         updated_at   = datetime('now')`,
    ).run(itemId, body.displayName ?? null, body.closingDay, body.dueDay);

    const row = db
      .prepare('SELECT * FROM card_settings WHERE item_id = ?')
      .get(itemId);
    res.json(row);
  } catch (err) {
    next(err);
  }
});
