import { Router } from 'express';
import { z } from 'zod';
import { users, AUTH_ENABLED } from '../config.js';
import {
  makeSessionCookie,
  cookieOptions,
  COOKIE_NAME,
  readSessionUser,
} from '../middleware/auth.js';

export const authRouter = Router();

authRouter.get('/auth/me', (req, res) => {
  const username = readSessionUser(req);
  if (username) {
    res.json({ authenticated: true, username });
    return;
  }
  res.json({ authenticated: false });
});

authRouter.post('/auth/login', (req, res) => {
  const { username, password } = z
    .object({
      username: z.string().min(1).optional(),
      password: z.string(),
    })
    .parse(req.body);

  if (!AUTH_ENABLED) {
    res.cookie(COOKIE_NAME, makeSessionCookie('default'), cookieOptions());
    res.json({ ok: true, username: 'default' });
    return;
  }

  if (!username) {
    res.status(400).json({ error: 'Username required' });
    return;
  }

  const expected = users.get(username.toLowerCase());
  if (expected && expected === password) {
    const u = username.toLowerCase();
    res.cookie(COOKIE_NAME, makeSessionCookie(u), cookieOptions());
    res.json({ ok: true, username: u });
    return;
  }

  res.status(401).json({ error: 'Credenciais inválidas' });
});

authRouter.post('/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});
