import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config, users, AUTH_ENABLED } from '../config.js';
import { getDb, type Db } from '../db/index.js';

const COOKIE_NAME = 'finance_session';
// 10 years in seconds
const MAX_AGE = 60 * 60 * 24 * 365 * 10;

// Default user used when AUTH_ENABLED is false (local dev with no USER_*
// env vars set). Keeps the single-tenant local-dev experience intact.
const ANON_USER = 'default';

const SECRET = config.SESSION_SECRET ?? 'finance-session-dev-secret';

declare module 'express-serve-static-core' {
  interface Request {
    db: Db;
    username: string;
  }
}

function sign(username: string): string {
  return createHmac('sha256', SECRET).update(`v2:${username}`).digest('hex');
}

export function makeSessionCookie(username: string): string {
  return `${username}.${sign(username)}`;
}

function verifyCookie(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const username = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  const expected = sign(username);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) return null;
  if (!users.has(username)) return null;
  return username;
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

export function readSessionUser(req: Request): string | null {
  if (!AUTH_ENABLED) return ANON_USER;
  return verifyCookie(req.cookies?.[COOKIE_NAME]);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const username = readSessionUser(req);
  if (!username) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.username = username;
  req.db = getDb(username);
  next();
}

export { COOKIE_NAME };
