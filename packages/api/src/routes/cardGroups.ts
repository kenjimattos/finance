import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { pickNextColor } from '../services/categoryColors.js';

export const cardGroupsRouter = Router();

const itemIdQuery = z.object({
  itemId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});
const createSchema = z.object({
  itemId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  name: z.string().min(1).max(40).trim(),
});
const renameSchema = z.object({ name: z.string().min(1).max(40).trim() });
const assignSchema = z.object({
  itemId: z.string().min(1),
  cardGroupId: z.number().int().positive().nullable(),
});

interface CardGroupRow {
  id: number;
  item_id: string;
  account_id: string | null;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

/**
 * GET /cards?itemId=... — list every card (by last4) discovered from the
 * transactions table for this item, along with its current group assignment,
 * transaction count, and most recent usage date. This is how the frontend
 * knows which cards exist without us having to maintain a separate cards
 * table — transactions.card_last4 is the source of truth.
 *
 * NULL card_last4 values are filtered out: not every transaction carries
 * this metadata (depends on the connector), and "unknown card" isn't
 * something the user can usefully assign to a group.
 */
cardGroupsRouter.get('/cards', (req, res, next) => {
  try {
    const { itemId, accountId } = itemIdQuery.parse(req.query);
    const filterByAccount = !!accountId;
    const rows = db
      .prepare(
        `SELECT t.card_last4  AS cardLast4,
                COUNT(*)       AS txCount,
                MAX(t.date)    AS lastUsed,
                cg.id          AS groupId,
                cg.name        AS groupName,
                cg.color       AS groupColor
         FROM transactions t
         LEFT JOIN card_group_members m
           ON m.item_id = t.item_id AND m.card_last4 = t.card_last4
         LEFT JOIN card_groups cg
           ON cg.id = m.card_group_id
         WHERE t.item_id = ? AND t.card_last4 IS NOT NULL
           AND (? = 0 OR t.account_id = ?)
         GROUP BY t.card_last4, cg.id
         ORDER BY lastUsed DESC`,
      )
      .all(itemId, filterByAccount ? 1 : 0, accountId ?? null) as Array<{
      cardLast4: string;
      txCount: number;
      lastUsed: string;
      groupId: number | null;
      groupName: string | null;
      groupColor: string | null;
    }>;

    res.json(
      rows.map((r) => ({
        cardLast4: r.cardLast4,
        txCount: r.txCount,
        lastUsed: r.lastUsed,
        group:
          r.groupId == null
            ? null
            : { id: r.groupId, name: r.groupName, color: r.groupColor },
      })),
    );
  } catch (err) {
    next(err);
  }
});

// GET /card-groups?itemId=... — list groups scoped to an item
cardGroupsRouter.get('/card-groups', (req, res, next) => {
  try {
    const { itemId, accountId } = itemIdQuery.parse(req.query);
    const filterByAccount = !!accountId;
    const rows = db
      .prepare(
        `SELECT g.id, g.item_id, g.account_id, g.name, g.color, g.created_at, g.updated_at,
                (SELECT COUNT(*) FROM card_group_members m WHERE m.card_group_id = g.id) AS memberCount
         FROM card_groups g
         WHERE g.item_id = ?
           AND (? = 0 OR g.account_id = ?)
         ORDER BY g.name ASC`,
      )
      .all(itemId, filterByAccount ? 1 : 0, accountId ?? null);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /card-groups — create a group { itemId, name }, auto color
cardGroupsRouter.post('/card-groups', (req, res, next) => {
  try {
    const { itemId, accountId, name } = createSchema.parse(req.body);

    // Validate the item exists — clean 404 instead of FK error
    const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
    if (!item) {
      res.status(404).json({ error: 'ItemNotFound' });
      return;
    }

    const existing = db
      .prepare('SELECT color FROM card_groups WHERE item_id = ?')
      .all(itemId) as Array<{ color: string }>;
    const color = pickNextColor(existing.map((r) => r.color));

    try {
      const info = db
        .prepare(
          'INSERT INTO card_groups (item_id, account_id, name, color) VALUES (?, ?, ?, ?)',
        )
        .run(itemId, accountId ?? null, name, color);
      const row = db
        .prepare('SELECT * FROM card_groups WHERE id = ?')
        .get(info.lastInsertRowid);
      res.status(201).json(row);
    } catch (err: any) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'GroupNameAlreadyExists' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// PUT /card-groups/:id — rename
cardGroupsRouter.put('/card-groups/:id', (req, res, next) => {
  try {
    const { name } = renameSchema.parse(req.body);
    const info = db
      .prepare(
        `UPDATE card_groups
         SET name = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(name, req.params.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'NotFound' });
      return;
    }
    const row = db
      .prepare('SELECT * FROM card_groups WHERE id = ?')
      .get(req.params.id) as CardGroupRow | undefined;
    res.json(row);
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'GroupNameAlreadyExists' });
      return;
    }
    next(err);
  }
});

// DELETE /card-groups/:id — cascades to members (they lose their assignment)
cardGroupsRouter.delete('/card-groups/:id', (req, res) => {
  const info = db
    .prepare('DELETE FROM card_groups WHERE id = ?')
    .run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ error: 'NotFound' });
    return;
  }
  res.status(204).send();
});

// PUT /cards/:last4/group — assign a card to a group, or clear it (null)
cardGroupsRouter.put('/cards/:last4/group', (req, res, next) => {
  try {
    const { itemId, cardGroupId } = assignSchema.parse(req.body);
    const last4 = decodeURIComponent(req.params.last4).trim();
    if (!last4) {
      res.status(400).json({ error: 'InvalidCardIdentifier' });
      return;
    }

    if (cardGroupId == null) {
      db.prepare(
        `DELETE FROM card_group_members WHERE item_id = ? AND card_last4 = ?`,
      ).run(itemId, last4);
      res.json({ ok: true, cardLast4: last4, group: null });
      return;
    }

    // Verify the group exists and belongs to this item
    const group = db
      .prepare(
        'SELECT id, name, color FROM card_groups WHERE id = ? AND item_id = ?',
      )
      .get(cardGroupId, itemId) as
      | { id: number; name: string; color: string }
      | undefined;
    if (!group) {
      res.status(404).json({ error: 'GroupNotFound' });
      return;
    }

    db.prepare(
      `INSERT INTO card_group_members (item_id, card_last4, card_group_id)
       VALUES (?, ?, ?)
       ON CONFLICT(item_id, card_last4) DO UPDATE SET
         card_group_id = excluded.card_group_id,
         created_at    = datetime('now')`,
    ).run(itemId, last4, cardGroupId);

    res.json({ ok: true, cardLast4: last4, group });
  } catch (err) {
    next(err);
  }
});
