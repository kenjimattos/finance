import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { extractMerchantSlug } from '../services/merchantSlug.js';

const DB_PATH = resolve(process.cwd(), 'data/finance.sqlite');

const db = new Database(DB_PATH);

const rows = db
  .prepare("SELECT id, date, amount, description FROM transactions WHERE source = 'pluggy'")
  .all() as Array<{ id: string; date: string; amount: number; description: string | null }>;

const update = db.prepare('UPDATE transactions SET identity_hash = ? WHERE id = ?');

const count = db.transaction(() => {
  let n = 0;
  for (const row of rows) {
    const slug = extractMerchantSlug(row.description) ?? '';
    const hash = createHash('sha256')
      .update(`${row.date}|${row.amount}|${slug}`)
      .digest('hex')
      .slice(0, 32);
    update.run(hash, row.id);
    n++;
  }
  return n;
})();

console.log(`Recomputed ${count} hashes.`);
db.close();
