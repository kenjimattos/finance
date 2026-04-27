import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { makeSessionToken, cookieOptions, COOKIE_NAME } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.get('/auth/me', (req, res) => {
  if (!config.APP_PASSWORD) {
    res.json({ authenticated: true });
    return;
  }
  const token = req.cookies?.[COOKIE_NAME];
  res.json({ authenticated: token === makeSessionToken() });
});

authRouter.post('/auth/login', (req, res) => {
  const { password } = z.object({ password: z.string() }).parse(req.body);

  if (!config.APP_PASSWORD || password === config.APP_PASSWORD) {
    res.cookie(COOKIE_NAME, makeSessionToken(), cookieOptions());
    res.json({ ok: true });
    return;
  }

  res.status(401).json({ error: 'Senha incorreta' });
});

authRouter.post('/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});
