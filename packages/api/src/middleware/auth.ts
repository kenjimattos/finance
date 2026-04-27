import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

const COOKIE_NAME = 'finance_session';
// 10 years in seconds
const MAX_AGE = 60 * 60 * 24 * 365 * 10;

export function makeSessionToken(): string {
  return createHmac('sha256', config.APP_PASSWORD ?? '').update('finance-session-v1').digest('hex');
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE * 1000,
    path: '/',
  };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.APP_PASSWORD) {
    next();
    return;
  }

  const token = req.cookies?.[COOKIE_NAME];
  if (token === makeSessionToken()) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export { COOKIE_NAME };
