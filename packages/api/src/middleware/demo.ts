import type { Request, Response, NextFunction } from 'express';
import { isDemoUser } from '../config.js';

/**
 * Blocks demo users from any route whose effect escapes their own SQLite
 * file. Everything else (categorization, splits, manual entries, cash-flow
 * edits...) stays writable — the point of the demo account is letting a
 * visitor actually use the product, and a re-run of the seed script resets
 * whatever they touched.
 *
 * Blocked surface:
 *   - Pluggy connect widget + item management (shared operator credentials)
 *   - sync endpoints (real Pluggy API calls)
 *   - fatura screenshot import (spends Anthropic credits)
 *   - admin routes (raw DB restore)
 *
 * Mounted right after authMiddleware, so req.username is always set.
 */
export function demoGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoUser(req.username)) {
    next();
    return;
  }

  const path = req.path;
  const blocked =
    path.startsWith('/connect-token') ||
    path.startsWith('/items') ||
    path === '/transactions/sync' ||
    path === '/cashflow/sync' ||
    path.startsWith('/transactions/import-fatura') ||
    path.startsWith('/admin');

  // GET /items must stay allowed — the Overview lists banks through it.
  if (blocked && !(req.method === 'GET' && path.startsWith('/items'))) {
    res.status(403).json({
      error: 'DemoRestricted',
      message: 'Esta ação não está disponível na conta de demonstração.',
    });
    return;
  }

  next();
}
