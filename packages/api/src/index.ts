import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';

import { config } from './config.js';
import { connectRouter } from './routes/connect.js';
import { itemsRouter } from './routes/items.js';
import { transactionsRouter } from './routes/transactions.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json());
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(connectRouter);
app.use(itemsRouter);
app.use(transactionsRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'ValidationError', details: err.issues });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'InternalServerError', message: err?.message });
};
app.use(errorHandler);

app.listen(config.PORT, () => {
  console.log(`[api] listening on http://localhost:${config.PORT}`);
});
