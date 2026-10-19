import { Router } from 'express';
import { z } from 'zod';
import { pluggy } from '../services/pluggy.js';

export const itemsRouter = Router();

// GET /items — list locally saved items (connections the user has linked)
itemsRouter.get('/items', (req, res) => {
  const rows = req.db.prepare('SELECT * FROM items ORDER BY created_at DESC').all();
  res.json(rows);
});

// POST /items — persist an itemId returned from the Pluggy Connect widget
const saveItemSchema = z.object({ itemId: z.string().min(1) });

itemsRouter.post('/items', async (req, res, next) => {
  try {
    const { itemId } = saveItemSchema.parse(req.body);

    // Validate with Pluggy and grab the connector name for display
    const item = await pluggy.fetchItem(itemId);
    console.log('[items] POST /items — itemId:', item.id, 'connector:', item.connector?.name, 'status:', item.status);

    // Upsert, never INSERT OR REPLACE: REPLACE deletes the row first, and the
    // ON DELETE CASCADE from accounts would wipe every account of the item
    // (settings, bank rows, balance anchors) when an item id is saved again.
    req.db.prepare(
      `INSERT INTO items (id, connector_name) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET connector_name = excluded.connector_name`,
    ).run(item.id, item.connector?.name ?? null);

    res.status(201).json({ id: item.id, connectorName: item.connector?.name });
  } catch (err) {
    next(err);
  }
});

// DELETE /items/:id — remove a bank connection and all its data.
// Cascades via ON DELETE CASCADE: accounts, bank_transactions, card_groups, etc.
// `transactions` and `bills` have no FK to accounts, so they are deleted by
// hand first; otherwise the item's credit rows would stay behind as orphans.
// The sync logs (sync_runs, transaction_payloads) are FK-less on purpose and
// outlive the connection. User-level data (user_categories, category_rules)
// is preserved.
itemsRouter.delete('/items/:id', (req, res) => {
  const { id } = req.params;
  const { db } = req;
  const result = db.transaction(() => {
    const ofItem = 'item_id = ? OR account_id IN (SELECT id FROM accounts WHERE item_id = ?)';
    db.prepare(`DELETE FROM transactions WHERE ${ofItem}`).run(id, id);
    db.prepare(`DELETE FROM bills WHERE ${ofItem}`).run(id, id);
    return db.prepare('DELETE FROM items WHERE id = ?').run(id);
  })();
  if (result.changes === 0) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.status(204).end();
});
