import { Router } from 'express';
import { pluggy } from '../services/pluggy.js';

export const connectRouter = Router();

// POST /connect-token
// Generates a short-lived token for the Pluggy Connect widget (frontend).
connectRouter.post('/connect-token', async (_req, res, next) => {
  try {
    const { accessToken } = await pluggy.createConnectToken();
    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
});
