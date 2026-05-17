import express, { Router, type Request, type Response } from 'express';
import { writeFileSync, copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

export const adminRouter = Router();

// raw body, up to 100mb — the sqlite file is binary
adminRouter.post(
  '/admin/restore-db',
  express.raw({ type: '*/*', limit: '100mb' }),
  (req: Request, res: Response) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'EmptyBody', hint: 'send the .sqlite file as raw binary body' });
      return;
    }

    // Restore writes to the SQLite file of the currently authenticated user.
    // The server must be restarted afterwards to reopen the connection on
    // the freshly written file (see note in the response).
    const target = join(config.DATABASE_DIR, `${req.username}.sqlite`);
    if (existsSync(target)) {
      const backup = `${target}.bak.${Date.now()}`;
      copyFileSync(target, backup);
    }

    writeFileSync(target, body);
    // Remove stale WAL/SHM sidecars from the previous (empty) DB so SQLite
    // doesn't replay their state on top of the freshly restored file.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = target + suffix;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    const size = statSync(target).size;

    res.json({
      ok: true,
      bytesWritten: size,
      target,
      note: 'Restart the Railway service to reopen the SQLite connection on the new file.',
    });
  },
);
