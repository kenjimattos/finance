/**
 * Seed a demo user's database with a synthetic-but-realistic dataset.
 *
 *   npm run -w @finance/api seed:demo            # seeds DATABASE_DIR/demo.sqlite
 *   npm run -w @finance/api seed:demo -- other   # seeds another demo username
 *
 * Everything is generated relative to the run date, so re-running keeps the
 * demo looking current: ~5 months of credit-card history on two banks,
 * categorized transactions with learned rules, installment purchases, splits
 * with a partner, card groups, a checking account with salary/rent/bill
 * payments, a balance anchor, and manual entries projecting the next months.
 *
 * The script WIPES the target database first. It refuses to run against a
 * username that isn't a demo account (see isDemoUser in config.ts) unless
 * --force is passed.
 *
 * The RNG is seeded, so two runs on the same day produce identical data.
 */
import { randomUUID, createHash } from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { isDemoUser } from '../config.js';
import { extractMerchantSlug } from '../services/merchantSlug.js';
import { CATEGORY_PALETTE } from '../services/categoryColors.js';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
// Railway preview environments boot with an empty volume, so the demo database
// has to be seeded on first start. Those environments also redeploy on every
// push to the PR branch — --if-empty keeps the seed a one-shot so a redeploy
// mid-review doesn't wipe whatever the reviewer had been clicking through.
const ifEmpty = argv.includes('--if-empty');
const USERNAME = (argv.find((a) => !a.startsWith('--')) ?? 'demo').toLowerCase();

if (!isDemoUser(USERNAME) && !force) {
  console.error(
    `Refusing to seed '${USERNAME}': not a demo user (set DEMO_USERS or pass --force). ` +
      'This script WIPES the target database.',
  );
  process.exit(1);
}

// ── Deterministic RNG ────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260101);
const between = (min: number, max: number) => Math.round((min + rng() * (max - min)) * 100) / 100;
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

// ── Date helpers (yyyy-mm-dd UTC strings, like the rest of the app) ─────────
const now = new Date();
const TODAY_Y = now.getUTCFullYear();
const TODAY_M = now.getUTCMonth() + 1; // 1-12
const TODAY_D = now.getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** {y, m} for the month `offset` months away from the current one. */
function monthAt(offset: number): { y: number; m: number } {
  const total = TODAY_Y * 12 + (TODAY_M - 1) + offset;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** yyyy-mm-dd with the day clamped to the month's length. */
function dateStr(y: number, m: number, day: number): string {
  return `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}
const TODAY = dateStr(TODAY_Y, TODAY_M, TODAY_D);
function addDays(dateISO: string, n: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// How far back the history goes (full months before the current one).
const HISTORY_MONTHS = 5;

// ── Fixed entities ──────────────────────────────────────────────────────────
const ITEM_NUBANK = 'demo-item-nubank';
const ITEM_ITAU = 'demo-item-itau';
const ACC_NU_CREDIT = 'demo-acc-nubank-credit';
const ACC_ITAU_CREDIT = 'demo-acc-itau-credit';
const ACC_ITAU_BANK = 'demo-acc-itau-bank';

const CARD_TITULAR = '5241';
const CARD_PARTNER = '0193';
const CARD_VIRTUAL = '8830';
const CARD_ITAU = '7702';

const CATEGORIES = [
  'Mercado',
  'Restaurantes',
  'Transporte',
  'Assinaturas',
  'Casa',
  'Saúde',
  'Lazer',
  'Compras',
  'Viagem',
] as const;
type CategoryName = (typeof CATEGORIES)[number];

interface Merchant {
  desc: string;
  cat: CategoryName;
  min: number;
  max: number;
  /** average visits per month */
  freq: number;
  card: string;
  /** chance [0,1] that a visit is split 50/50 with the partner */
  halfChance?: number;
  /** every visit belongs to the partner (their card, they owe 100%) */
  theirs?: boolean;
}

const NUBANK_MERCHANTS: Merchant[] = [
  { desc: 'SUPERMERCADO ZONA SUL', cat: 'Mercado', min: 130, max: 460, freq: 3, card: CARD_TITULAR, halfChance: 0.9 },
  { desc: 'HORTIFRUTI CENTRAL', cat: 'Mercado', min: 35, max: 110, freq: 2, card: CARD_TITULAR, halfChance: 0.9 },
  { desc: 'IFOOD *IFD', cat: 'Restaurantes', min: 42, max: 145, freq: 4, card: CARD_TITULAR, halfChance: 0.6 },
  { desc: 'PADARIA ALVORADA', cat: 'Restaurantes', min: 14, max: 52, freq: 3, card: CARD_TITULAR },
  { desc: 'RESTAURANTE TERRACO', cat: 'Restaurantes', min: 95, max: 280, freq: 1, card: CARD_TITULAR, halfChance: 0.8 },
  { desc: 'UBER *TRIP', cat: 'Transporte', min: 11, max: 46, freq: 4, card: CARD_TITULAR },
  { desc: '99APP *99APP', cat: 'Transporte', min: 9, max: 34, freq: 2, card: CARD_TITULAR },
  { desc: 'POSTO SHELL', cat: 'Transporte', min: 150, max: 310, freq: 1, card: CARD_TITULAR },
  { desc: 'DROGARIA PACHECO', cat: 'Saúde', min: 24, max: 160, freq: 1.2, card: CARD_TITULAR },
  { desc: 'AMAZON.COM.BR', cat: 'Compras', min: 39, max: 320, freq: 1.5, card: CARD_VIRTUAL },
  { desc: 'MERCADOLIVRE*MERCADOLIVRE', cat: 'Compras', min: 32, max: 270, freq: 1.4, card: CARD_VIRTUAL },
  { desc: 'STEAM GAMES', cat: 'Lazer', min: 28, max: 150, freq: 0.6, card: CARD_VIRTUAL },
  { desc: 'CINEMARK', cat: 'Lazer', min: 42, max: 96, freq: 0.7, card: CARD_TITULAR, halfChance: 0.9 },
  { desc: 'LEROY MERLIN', cat: 'Casa', min: 65, max: 430, freq: 0.5, card: CARD_TITULAR, halfChance: 0.5 },
  // Partner's additional card — every purchase is "dela".
  { desc: 'LOJAS RENNER', cat: 'Compras', min: 85, max: 340, freq: 1, card: CARD_PARTNER, theirs: true },
  { desc: 'SEPHORA', cat: 'Compras', min: 95, max: 290, freq: 0.6, card: CARD_PARTNER, theirs: true },
  { desc: 'O BOTICARIO', cat: 'Compras', min: 48, max: 175, freq: 0.7, card: CARD_PARTNER, theirs: true },
];

const ITAU_MERCHANTS: Merchant[] = [
  { desc: 'CARREFOUR', cat: 'Mercado', min: 160, max: 520, freq: 1.5, card: CARD_ITAU, halfChance: 0.8 },
  { desc: 'POSTO IPIRANGA', cat: 'Transporte', min: 140, max: 290, freq: 1, card: CARD_ITAU },
  { desc: 'OUTBACK STEAKHOUSE', cat: 'Restaurantes', min: 180, max: 380, freq: 0.6, card: CARD_ITAU, halfChance: 0.9 },
  { desc: 'DROGASIL', cat: 'Saúde', min: 28, max: 140, freq: 0.8, card: CARD_ITAU },
  { desc: 'PETZ', cat: 'Casa', min: 60, max: 210, freq: 0.8, card: CARD_ITAU, halfChance: 0.5 },
];

// Fixed-amount monthly subscriptions (always on the virtual card).
const SUBSCRIPTIONS: Array<{ desc: string; amount: number; day: number; account: 'nu' }> = [
  { desc: 'NETFLIX.COM', amount: 59.9, day: 3, account: 'nu' },
  { desc: 'SPOTIFY', amount: 34.9, day: 7, account: 'nu' },
  { desc: 'AMAZONPRIMEBR', amount: 19.9, day: 11, account: 'nu' },
  { desc: 'EC *ICLOUD.COM/BILL', amount: 12.9, day: 19, account: 'nu' },
];

// Installment purchases: first parcel `startOffset` months ago, one parcel per
// month on (roughly) the same day. Parcels dated after today are not created —
// they exist only as the remaining installments the UI projects.
const INSTALLMENT_PURCHASES: Array<{
  desc: string;
  cat: CategoryName;
  parcel: number;
  total: number;
  startOffset: number;
  day: number;
  account: 'nu' | 'itau';
  card: string;
  half?: boolean;
}> = [
  { desc: 'APPLE STORE', cat: 'Compras', parcel: 291.58, total: 12, startOffset: -5, day: 9, account: 'nu', card: CARD_TITULAR },
  { desc: 'MAGAZINE LUIZA', cat: 'Casa', parcel: 187.45, total: 8, startOffset: -4, day: 21, account: 'nu', card: CARD_TITULAR, half: true },
  { desc: 'GOL LINHAS AEREAS', cat: 'Viagem', parcel: 421.3, total: 6, startOffset: -3, day: 13, account: 'nu', card: CARD_TITULAR, half: true },
  { desc: 'DECATHLON', cat: 'Lazer', parcel: 156.63, total: 3, startOffset: -1, day: 5, account: 'nu', card: CARD_TITULAR },
  { desc: 'TOK STOK', cat: 'Casa', parcel: 214.9, total: 10, startOffset: -4, day: 17, account: 'itau', card: CARD_ITAU, half: true },
];

// Recent purchases at merchants the system has never seen — they land in the
// inbox uncategorized, showing off the categorization flow.
const INBOX_MERCHANTS: Array<{ desc: string; daysAgo: number; amount: number; account: 'nu' | 'itau' }> = [
  { desc: 'RESTAURANTE NOVO SABOR', daysAgo: 0, amount: 87.5, account: 'nu' },
  { desc: 'PET SHOP AMIGO FIEL', daysAgo: 1, amount: 134.2, account: 'nu' },
  { desc: 'LIVRARIA ARGUMENTO', daysAgo: 2, amount: 76.4, account: 'nu' },
  { desc: 'PAG*FEIRADEARTESANATO', daysAgo: 3, amount: 45.0, account: 'nu' },
  { desc: 'EMPORIO GRAO SAGRADO', daysAgo: 2, amount: 112.9, account: 'itau' },
];

// ── Seed ────────────────────────────────────────────────────────────────────
// getDb creates the file and runs migrations, so an untouched database is not
// "missing tables" but "tables with nothing in them" — count rows, don't stat.
const db = getDb(USERNAME);

if (ifEmpty) {
  const existing = (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n;
  if (existing > 0) {
    console.log(`Skipping seed of '${USERNAME}': already has ${existing} transactions.`);
    process.exit(0);
  }
}

function wipe(db: Db): void {
  // Order matters only for tables without cascades; everything hanging off
  // items/accounts/transactions/user_categories is removed by ON DELETE CASCADE.
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM items;
    DELETE FROM user_categories;
    DELETE FROM manual_entries;
    DELETE FROM transaction_sync_conflicts;
  `);
}

interface TxInput {
  accountId: string;
  itemId: string;
  date: string;
  desc: string;
  amount: number;
  card: string | null;
  cat?: CategoryName | null;
  assignedBy?: 'manual' | 'learned';
  split?: 'half' | 'theirs' | null;
  installment?: { n: number; total: number } | null;
}

const seed = db.transaction(() => {
  wipe(db);

  // Items + accounts -----------------------------------------------------
  const insItem = db.prepare('INSERT INTO items (id, connector_name) VALUES (?, ?)');
  insItem.run(ITEM_NUBANK, 'Nubank');
  insItem.run(ITEM_ITAU, 'Itaú');

  const insAccount = db.prepare(
    `INSERT INTO accounts (id, item_id, name, number, type, subtype, balance, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
  );
  insAccount.run(ACC_NU_CREDIT, ITEM_NUBANK, 'Nubank Mastercard', CARD_TITULAR, 'CREDIT', 'CREDIT_CARD', null);
  insAccount.run(ACC_ITAU_CREDIT, ITEM_ITAU, 'Itaú Visa Platinum', CARD_ITAU, 'CREDIT', 'CREDIT_CARD', null);
  insAccount.run(ACC_ITAU_BANK, ITEM_ITAU, 'Itaú Conta Corrente', '30791-4', 'BANK', 'CHECKING_ACCOUNT', null);

  const insSettings = db.prepare(
    `INSERT INTO account_settings (account_id, display_name, closing_day, due_day)
     VALUES (?, ?, ?, ?)`,
  );
  insSettings.run(ACC_NU_CREDIT, 'Nubank', 16, 25);
  insSettings.run(ACC_ITAU_CREDIT, 'Itaú', 3, 10);

  // Card groups (Nubank only) ---------------------------------------------
  const insGroup = db.prepare(
    'INSERT INTO card_groups (item_id, account_id, name, color) VALUES (?, ?, ?, ?)',
  );
  const insMember = db.prepare(
    'INSERT INTO card_group_members (item_id, account_id, card_last4, card_group_id) VALUES (?, ?, ?, ?)',
  );
  const groups: Array<[string, string, string]> = [
    ['Titular', CATEGORY_PALETTE[6], CARD_TITULAR],
    ['Ana', CATEGORY_PALETTE[5], CARD_PARTNER],
    ['Virtual', CATEGORY_PALETTE[2], CARD_VIRTUAL],
  ];
  for (const [name, color, last4] of groups) {
    const gid = insGroup.run(ITEM_NUBANK, ACC_NU_CREDIT, name, color).lastInsertRowid;
    insMember.run(ITEM_NUBANK, ACC_NU_CREDIT, last4, gid);
  }

  // Categories --------------------------------------------------------------
  const insCategory = db.prepare('INSERT INTO user_categories (name, color) VALUES (?, ?)');
  const categoryIds = new Map<CategoryName, number>();
  CATEGORIES.forEach((name, i) => {
    const id = insCategory.run(name, CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]).lastInsertRowid;
    categoryIds.set(name, Number(id));
  });

  // Transactions --------------------------------------------------------------
  const insTx = db.prepare(
    `INSERT INTO transactions
       (id, provider_transaction_id, account_id, item_id, date, description, amount,
        currency_code, type, status, installment_number, total_installments,
        card_last4, source, identity_hash, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BRL', ?, 'POSTED', ?, ?, ?, 'pluggy', ?, '{}')`,
  );
  const insTxCategory = db.prepare(
    'INSERT INTO transaction_categories (transaction_id, user_category_id, assigned_by) VALUES (?, ?, ?)',
  );
  const insSplit = db.prepare(
    'INSERT INTO transaction_splits (transaction_id, split_type) VALUES (?, ?)',
  );

  const ruleStats = new Map<string, { cat: CategoryName; hits: number }>();

  function addTx(t: TxInput): void {
    const id = randomUUID();
    const slug = extractMerchantSlug(t.desc) ?? '';
    const hash = createHash('sha256')
      .update(`${t.date}|${t.amount}|${slug}`)
      .digest('hex')
      .slice(0, 32);
    insTx.run(
      id,
      `demo-${id.slice(0, 18)}`,
      t.accountId,
      t.itemId,
      t.date,
      t.desc,
      t.amount,
      t.amount < 0 ? 'CREDIT' : 'DEBIT',
      t.installment ? t.installment.n : null,
      t.installment ? t.installment.total : null,
      t.card,
      hash,
    );
    if (t.cat) {
      insTxCategory.run(id, categoryIds.get(t.cat), t.assignedBy ?? 'learned');
      if (slug) {
        const stat = ruleStats.get(slug);
        if (stat) stat.hits += 1;
        else ruleStats.set(slug, { cat: t.cat, hits: 1 });
      }
    }
    if (t.split) insSplit.run(id, t.split);
  }

  const creditAccount = (which: 'nu' | 'itau') =>
    which === 'nu'
      ? { accountId: ACC_NU_CREDIT, itemId: ITEM_NUBANK }
      : { accountId: ACC_ITAU_CREDIT, itemId: ITEM_ITAU };

  // Regular merchant visits, month by month.
  for (let offset = -HISTORY_MONTHS; offset <= 0; offset++) {
    const { y, m } = monthAt(offset);
    const maxDay = offset === 0 ? TODAY_D : daysInMonth(y, m);
    const monthVisits = (merchants: Merchant[], which: 'nu' | 'itau') => {
      for (const mch of merchants) {
        let visits = Math.floor(mch.freq) + (rng() < mch.freq % 1 ? 1 : 0);
        while (visits-- > 0) {
          const day = 1 + Math.floor(rng() * maxDay);
          if (offset === -HISTORY_MONTHS && day < 15) continue; // ramp in gently
          const split = mch.theirs ? 'theirs' : mch.halfChance && rng() < mch.halfChance ? 'half' : null;
          addTx({
            ...creditAccount(which),
            date: dateStr(y, m, day),
            desc: mch.desc,
            amount: between(mch.min, mch.max),
            card: mch.card,
            cat: mch.cat,
            split,
          });
        }
      }
    };
    monthVisits(NUBANK_MERCHANTS, 'nu');
    monthVisits(ITAU_MERCHANTS, 'itau');

    // Subscriptions post on fixed days with fixed amounts.
    for (const sub of SUBSCRIPTIONS) {
      if (offset === 0 && sub.day > TODAY_D) continue;
      addTx({
        ...creditAccount(sub.account),
        date: dateStr(y, m, sub.day),
        desc: sub.desc,
        amount: sub.amount,
        card: CARD_VIRTUAL,
        cat: 'Assinaturas',
      });
    }
  }

  // Installment parcels up to today.
  for (const p of INSTALLMENT_PURCHASES) {
    for (let n = 1; n <= p.total; n++) {
      const { y, m } = monthAt(p.startOffset + (n - 1));
      const date = dateStr(y, m, p.day);
      if (date > TODAY) break;
      addTx({
        ...creditAccount(p.account),
        date,
        desc: p.desc,
        amount: p.parcel,
        card: p.card,
        cat: p.cat,
        assignedBy: n === 1 ? 'manual' : 'learned',
        split: p.half ? 'half' : null,
        installment: { n, total: p.total },
      });
    }
  }

  // One refund, for the estorno rendering path.
  addTx({
    ...creditAccount('nu'),
    date: addDays(TODAY, -6),
    desc: 'ESTORNO AMAZON.COM.BR',
    amount: -89.9,
    card: CARD_VIRTUAL,
    cat: 'Compras',
  });

  // Fresh, never-seen merchants → uncategorized inbox rows.
  for (const row of INBOX_MERCHANTS) {
    addTx({
      ...creditAccount(row.account),
      date: addDays(TODAY, -row.daysAgo),
      desc: row.desc,
      amount: row.amount,
      card: row.account === 'nu' ? CARD_TITULAR : CARD_ITAU,
      cat: null,
    });
  }

  // Learned rules + category usage counters ------------------------------
  const insRule = db.prepare(
    'INSERT INTO category_rules (user_category_id, merchant_slug, hit_count) VALUES (?, ?, ?)',
  );
  for (const [slug, stat] of ruleStats) {
    insRule.run(categoryIds.get(stat.cat), slug, stat.hits);
  }
  db.prepare(
    `UPDATE user_categories SET usage_count =
       (SELECT COUNT(*) FROM transaction_categories tc WHERE tc.user_category_id = user_categories.id)`,
  ).run();

  // Bank account: checking history ----------------------------------------
  const insBankTx = db.prepare(
    `INSERT INTO bank_transactions
       (id, provider_transaction_id, account_id, item_id, date, description, amount,
        currency_code, type, status, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'BRL', ?, 'POSTED', '{}')`,
  );
  let bankSum = 0;
  function addBankTx(date: string, desc: string, amount: number): void {
    if (date > TODAY) return;
    const id = randomUUID();
    insBankTx.run(id, `demo-${id.slice(0, 18)}`, ACC_ITAU_BANK, ITEM_ITAU, date, desc, amount, amount < 0 ? 'DEBIT' : 'CREDIT');
    bankSum += amount;
  }

  for (let offset = -HISTORY_MONTHS; offset <= 0; offset++) {
    const { y, m } = monthAt(offset);
    const d = (day: number) => dateStr(y, m, day);
    addBankTx(d(1), 'TED SALARIO ACME TECNOLOGIA LTDA', 12400);
    addBankTx(d(2), 'APLICACAO AUTOMATICA CDB', -1500);
    addBankTx(d(5), 'PIX ENVIADO ALUGUEL ED AURORA', -2850);
    addBankTx(d(8), 'PIX ENVIADO COND ED AURORA', -685);
    addBankTx(d(12), 'DEB AUTOM LIGHT ENERGIA', between(-320, -175));
    addBankTx(d(15), 'DEB AUTOM VIVO FIBRA', -119.9);
    addBankTx(d(20), 'DEB AUTOM SMART FIT', -159.9);
    // Credit card bill payments (auto-detected via "FATURA" in the description).
    addBankTx(d(25), 'PAGAMENTO FATURA NUBANK', between(-5200, -3900));
    addBankTx(d(10), 'PAGTO FATURA CARTAO ITAU', between(-1900, -1150));
    // Freelance income every other month.
    if ((y * 12 + m) % 2 === 0) addBankTx(d(17), 'PIX RECEBIDO FREELANCE DESIGN', between(900, 2400));
    // Misc day-to-day movements.
    const misc = 5 + Math.floor(rng() * 4);
    for (let i = 0; i < misc; i++) {
      const day = 1 + Math.floor(rng() * daysInMonth(y, m));
      const kind = rng();
      if (kind < 0.35) addBankTx(d(day), 'PIX ENVIADO ANA M', between(-380, -45));
      else if (kind < 0.65) addBankTx(d(day), 'COMPRA DEBITO PADARIA ALVORADA', between(-58, -14));
      else if (kind < 0.8) addBankTx(d(day), 'SAQUE BANCO24H', -200);
      else addBankTx(d(day), 'PIX RECEBIDO REEMBOLSO', between(40, 220));
    }
  }

  // Balance anchor the day before history starts, then set the live balance
  // to anchor + everything that happened since (keeps the two consistent).
  const historyStart = dateStr(monthAt(-HISTORY_MONTHS).y, monthAt(-HISTORY_MONTHS).m, 1);
  const anchorDate = addDays(historyStart, -1);
  const anchorBalance = 5800;
  db.prepare(
    `INSERT INTO balance_anchors (account_id, anchor_date, balance, source)
     VALUES (?, ?, ?, 'manual')`,
  ).run(ACC_ITAU_BANK, anchorDate, anchorBalance);
  db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(
    Math.round((anchorBalance + bankSum) * 100) / 100,
    ACC_ITAU_BANK,
  );

  // Manual entries projecting the current + next 2 months -------------------
  const insManual = db.prepare(
    'INSERT INTO manual_entries (description, amount, day_of_month, month) VALUES (?, ?, ?, ?)',
  );
  for (let offset = 0; offset <= 2; offset++) {
    const { y, m } = monthAt(offset);
    const month = `${y}-${pad(m)}`;
    insManual.run('Salário', 12400, 1, month);
    insManual.run('Aplicação CDB', -1500, 2, month);
    insManual.run('Aluguel', -2850, 5, month);
    insManual.run('Condomínio', -685, 8, month);
    insManual.run('Energia', -240, 12, month);
    insManual.run('Internet', -119.9, 15, month);
    insManual.run('Academia', -159.9, 20, month);
  }
});

seed();

const counts = {
  transactions: (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n,
  categorized: (db.prepare('SELECT COUNT(*) n FROM transaction_categories').get() as { n: number }).n,
  splits: (db.prepare('SELECT COUNT(*) n FROM transaction_splits').get() as { n: number }).n,
  rules: (db.prepare('SELECT COUNT(*) n FROM category_rules').get() as { n: number }).n,
  bankTransactions: (db.prepare('SELECT COUNT(*) n FROM bank_transactions').get() as { n: number }).n,
  manualEntries: (db.prepare('SELECT COUNT(*) n FROM manual_entries').get() as { n: number }).n,
};
console.log(`Seeded '${USERNAME}':`, counts);
