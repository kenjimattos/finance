import { Router, json } from 'express';
import { z } from 'zod';
import { extractText } from 'unpdf';
import {
  extractFaturaFromImages,
  extractFaturaFromPdfText,
  isImportEnabled,
  type FaturaImage,
} from '../services/extractFatura.js';
import { computeBillWindowAtOffset, findOffsetForDate } from '../services/billWindow.js';
import { reconcileFatura, type AppLine } from '../services/reconcileFatura.js';
import { insertManualTransaction } from '../db/manualTransaction.js';
import type { Db } from '../db/index.js';

export const faturaImportRouter = Router();

// Screenshots/PDFs are base64 in the JSON body, so this router needs a larger
// limit than the global express.json(). Scoped here (prefix match, so it also
// covers /reconcile) so other routes keep the default.
faturaImportRouter.use('/transactions/import-fatura', json({ limit: '25mb' }));

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const imageSchema = z.object({
  data: z.string().min(1),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
});

const extractSchema = z.object({
  accountId: z.string().min(1),
  billOffset: z.number().int(),
  images: z.array(imageSchema).min(1).max(20),
});

interface AccountSettingsRow {
  item_id: string;
  closing_day: number;
  due_day: number;
}

function loadAccount(db: Db, accountId: string): AccountSettingsRow | null {
  const row = db
    .prepare(
      `SELECT a.item_id AS item_id, s.closing_day AS closing_day, s.due_day AS due_day
       FROM accounts a
       LEFT JOIN account_settings s ON s.account_id = a.id
       WHERE a.id = ?`,
    )
    .get(accountId) as
    | { item_id: string; closing_day: number | null; due_day: number | null }
    | undefined;
  if (!row) return null;
  if (row.closing_day == null || row.due_day == null) return null;
  return { item_id: row.item_id, closing_day: row.closing_day, due_day: row.due_day };
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// POST /transactions/import-fatura/extract — read screenshots, return rows
// (NOT inserted). Each row carries the bill_shift needed to land it in the bill
// the user is viewing, computed from its natural cycle.
faturaImportRouter.post('/transactions/import-fatura/extract', async (req, res, next) => {
  try {
    if (!isImportEnabled()) {
      res.status(503).json({ error: 'Importação por screenshot não está configurada (ANTHROPIC_API_KEY ausente).' });
      return;
    }
    const { db } = req;
    const body = extractSchema.parse(req.body);

    const account = loadAccount(db, body.accountId);
    if (!account) {
      res.status(400).json({ error: 'Conta não encontrada ou sem dia de fechamento/vencimento configurado.' });
      return;
    }

    const settings = { closingDay: account.closing_day, dueDay: account.due_day };
    const win = computeBillWindowAtOffset(settings, body.billOffset);

    const images: FaturaImage[] = body.images.map((i) => ({ data: i.data, mediaType: i.mediaType }));
    const rows = await extractFaturaFromImages(images, {
      periodStart: win.periodStart,
      periodEnd: win.periodEnd,
      referenceDate: todayYmd(),
    });

    // Annotate each row with the shift needed to pull it into the target bill.
    const annotated = rows.map((r) => {
      const natural = findOffsetForDate(settings, r.date);
      const billShift = natural == null ? 0 : body.billOffset - natural;
      return { ...r, billShift };
    });

    res.json({
      window: { periodStart: win.periodStart, periodEnd: win.periodEnd, nextDueDate: win.nextDueDate },
      rows: annotated,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'IMPORT_DISABLED') {
      res.status(503).json({ error: 'Importação por screenshot não está configurada.' });
      return;
    }
    // Surface upstream rate-limits (common on free gateway tiers) as 429 with a
    // retry hint instead of a generic 500.
    if (typeof (err as { status?: number }).status === 'number') {
      const status = (err as { status: number }).status;
      if (status === 429) {
        res.status(429).json({ error: 'Provedor de visão ocupado (limite temporário). Tente de novo em alguns segundos.' });
        return;
      }
    }
    next(err);
  }
});

const commitRowSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().min(1),
    amount: z.number().finite(),
    cardLast4: z.string().nullable().optional(),
    installmentNumber: z.number().int().positive().nullable().optional(),
    totalInstallments: z.number().int().positive().nullable().optional(),
    billShift: z.number().int().gte(-24).lte(24).nullable().optional(),
  })
  .refine((d) => (d.installmentNumber == null) === (d.totalInstallments == null), {
    message: 'installmentNumber and totalInstallments must be provided together',
  });

const commitSchema = z.object({
  accountId: z.string().min(1),
  rows: z.array(commitRowSchema).min(1).max(500),
});

// POST /transactions/import-fatura/commit — insert the reviewed rows as manual
// transactions, applying each row's bill_shift. Atomic: all-or-nothing.
faturaImportRouter.post('/transactions/import-fatura/commit', (req, res, next) => {
  try {
    const { db } = req;
    const body = commitSchema.parse(req.body);

    const account = db
      .prepare('SELECT item_id FROM accounts WHERE id = ?')
      .get(body.accountId) as { item_id: string } | undefined;
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const insertAll = db.transaction((rows: z.infer<typeof commitRowSchema>[]) => {
      const ids: string[] = [];
      for (const r of rows) {
        ids.push(
          insertManualTransaction(db, {
            accountId: body.accountId,
            itemId: account.item_id,
            date: r.date,
            description: r.description,
            amount: r.amount,
            cardLast4: r.cardLast4 ?? null,
            installmentNumber: r.installmentNumber ?? null,
            totalInstallments: r.totalInstallments ?? null,
            billShift: r.billShift ?? null,
          }),
        );
      }
      return ids;
    });

    const ids = insertAll(body.rows);
    res.status(201).json({ ok: true, count: ids.length, ids });
  } catch (err) {
    next(err);
  }
});

// ── Reconciliation: closed-bill PDF vs the app's bill ───────────────────────

const reconcileSchema = z.object({
  accountId: z.string().min(1),
  billOffset: z.number().int(),
  /** base64-encoded PDF bytes (no data: prefix). */
  pdf: z.string().min(1),
});

/**
 * Load every transaction that lands in the given bill window (shift-aware,
 * same three-window predicate as routes/bills.ts), with its category name.
 * Categorized or not — reconciliation wants the full inbox.
 */
function loadWindowLines(
  db: Db,
  accountId: string,
  current: { periodStart: string; periodEnd: string },
  previous: { periodStart: string; periodEnd: string },
  next: { periodStart: string; periodEnd: string },
): AppLine[] {
  return db
    .prepare(
      `SELECT t.id                 AS id,
              t.date               AS date,
              COALESCE(d.description, t.description, '') AS description,
              COALESCE(t.amount_in_account_currency, t.amount) AS amount,
              t.card_last4         AS cardLast4,
              t.installment_number AS installmentNumber,
              t.total_installments AS totalInstallments,
              t.source             AS source,
              uc.name              AS category
       FROM transactions t
       LEFT JOIN transaction_bill_overrides o ON o.transaction_id = t.id
       LEFT JOIN transaction_categories tc ON tc.transaction_id = t.id
       LEFT JOIN user_categories uc ON uc.id = tc.user_category_id
       LEFT JOIN transaction_description_overrides d ON d.transaction_id = t.id
       WHERE t.account_id = ?
         AND (
              (o.shift IS NULL AND t.date >= ? AND t.date <= ?)
           OR (o.shift = 1     AND t.date >= ? AND t.date <= ?)
           OR (o.shift = -1    AND t.date >= ? AND t.date <= ?)
         )`,
    )
    .all(
      accountId,
      current.periodStart, current.periodEnd,
      previous.periodStart, previous.periodEnd,
      next.periodStart, next.periodEnd,
    ) as AppLine[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// POST /transactions/import-fatura/reconcile — read a closed-bill PDF and diff
// it against the bill the user is viewing. Read-only: returns the report; the
// user applies fixes through the existing commit/manual endpoints.
faturaImportRouter.post('/transactions/import-fatura/reconcile', async (req, res, next) => {
  try {
    if (!isImportEnabled()) {
      res.status(503).json({ error: 'Conciliação por PDF não está configurada (ANTHROPIC_API_KEY ausente).' });
      return;
    }
    const { db } = req;
    const body = reconcileSchema.parse(req.body);

    const account = loadAccount(db, body.accountId);
    if (!account) {
      res.status(400).json({ error: 'Conta não encontrada ou sem dia de fechamento/vencimento configurado.' });
      return;
    }

    const settings = { closingDay: account.closing_day, dueDay: account.due_day };
    const win = computeBillWindowAtOffset(settings, body.billOffset);
    const prev = computeBillWindowAtOffset(settings, body.billOffset - 1);
    const nxt = computeBillWindowAtOffset(settings, body.billOffset + 1);

    // Text-based statement PDFs (PicPay, Nubank…) extract locally; the LLM only
    // sees text, which is cheap and gateway-agnostic. Scanned PDFs have no text
    // layer — tell the user to use the screenshot import instead.
    const { text } = await extractText(new Uint8Array(Buffer.from(body.pdf, 'base64')), {
      mergePages: true,
    });
    if (text.trim().length < 100) {
      res.status(422).json({ error: 'O PDF não tem texto extraível (escaneado?). Use a importação por screenshots.' });
      return;
    }

    const statementLines = await extractFaturaFromPdfText(text, {
      periodStart: win.periodStart,
      periodEnd: win.periodEnd,
      referenceDate: todayYmd(),
    });

    const appLines = loadWindowLines(db, body.accountId, win, prev, nxt);
    const result = reconcileFatura(statementLines, appLines);

    // Insert candidates: bill queries only honor shift ±1, so a statement line
    // whose natural cycle is further away (parceladas keep the original
    // purchase date) is re-dated to the closing date — the same convention the
    // manual installment rows already follow.
    const missingInApp = result.missingInApp.map((s) => {
      const natural = findOffsetForDate(settings, s.date);
      const shift = natural == null ? null : body.billOffset - natural;
      if (shift != null && Math.abs(shift) <= 1) {
        return { ...s, date: s.date, statementDate: s.date, billShift: shift };
      }
      return { ...s, date: win.periodEnd, statementDate: s.date, billShift: 0 };
    });

    const appBillTotal = round2(
      appLines.filter((l) => l.category != null).reduce((sum, l) => sum + l.amount, 0),
    );
    const statementTotal = round2(
      [...result.matched, ...result.amountMismatches]
        .map((p) => p.statement.amount)
        .concat(result.missingInApp.map((s) => s.amount))
        .reduce((sum, a) => sum + a, 0),
    );

    res.json({
      window: { periodStart: win.periodStart, periodEnd: win.periodEnd, nextDueDate: win.nextDueDate },
      appBillTotal,
      statementTotal,
      delta: round2(appBillTotal - statementTotal),
      matchedCount: result.matched.length,
      missingInApp,
      amountMismatches: result.amountMismatches,
      onlyInApp: result.onlyInApp,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'IMPORT_DISABLED') {
      res.status(503).json({ error: 'Conciliação por PDF não está configurada.' });
      return;
    }
    if (typeof (err as { status?: number }).status === 'number') {
      const status = (err as { status: number }).status;
      if (status === 429) {
        res.status(429).json({ error: 'Provedor de IA ocupado (limite temporário). Tente de novo em alguns segundos.' });
        return;
      }
    }
    next(err);
  }
});
