import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';

import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { authMiddleware } from './middleware/auth.js';
import { connectRouter } from './routes/connect.js';
import { itemsRouter } from './routes/items.js';
import { transactionsRouter } from './routes/transactions.js';
import { cardSettingsRouter } from './routes/cardSettings.js';
import { categoriesRouter } from './routes/categories.js';
import { billsRouter } from './routes/bills.js';
import { categorizeRouter } from './routes/categorize.js';
import { cardGroupsRouter } from './routes/cardGroups.js';
import { accountsRouter } from './routes/accounts.js';
import { manualEntriesRouter } from './routes/manualEntries.js';
import { cashflowRouter } from './routes/cashflow.js';
import { splitsRouter } from './routes/splits.js';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
if (config.CORS_ORIGIN) {
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
}
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

if (!config.APP_PASSWORD) {
  console.warn('[auth] APP_PASSWORD not set — authentication disabled');
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(authRouter);
app.use(authMiddleware);

app.use(connectRouter);
app.use(itemsRouter);
app.use(accountsRouter);
app.use(cardSettingsRouter);
app.use(cardGroupsRouter);
app.use(categoriesRouter);
app.use(billsRouter);
app.use(transactionsRouter);
app.use(categorizeRouter);
app.use(manualEntriesRouter);
app.use(cashflowRouter);
app.use(splitsRouter);

if (process.env.NODE_ENV === 'production') {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDist = join(__dirname, '..', '..', 'web', 'dist');
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'ValidationError', details: err.issues });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'InternalServerError', message: err?.message });
};
app.use(errorHandler);

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`[api] listening on http://0.0.0.0:${config.PORT}`);
});
