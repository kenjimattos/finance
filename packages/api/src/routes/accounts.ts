import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';

export const accountsRouter = Router();

const querySchema = z.object({ itemId: z.string().min(1) });

interface AccountRow {
  id: string;
  item_id: string;
  name: string | null;
  number: string | null;
  type: string | null;
  synced_at: string;
}

// GET /accounts?itemId=... — list accounts for a given Pluggy item
accountsRouter.get('/accounts', (req, res, next) => {
  try {
    const { itemId } = querySchema.parse(req.query);
    const rows = db
      .prepare(
        `SELECT id, item_id, name, number, type, synced_at
         FROM accounts
         WHERE item_id = ?
         ORDER BY type ASC, name ASC`,
      )
      .all(itemId) as AccountRow[];

    res.json(
      rows.map((r) => ({
        id: r.id,
        itemId: r.item_id,
        name: r.name,
        number: r.number,
        type: r.type,
        syncedAt: r.synced_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});
