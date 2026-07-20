/**
 * Reconcile a closed-bill statement (extracted from the issuer's PDF) against
 * the transactions the app has for the same bill window.
 *
 * Pure — no SQL, no network — so it carries unit tests. The route loads the
 * app rows (shift-aware, same three-window logic as routes/bills.ts) and the
 * statement rows (services/extractFatura.ts), and this module pairs them:
 *
 *   matched           statement line found in the app with the same value
 *   amountMismatches  same purchase, few-cents difference (typically manual
 *                     installment rows whose cent distribution differs from
 *                     the issuer's)
 *   missingInApp      statement lines with no app counterpart → insert candidates
 *   onlyInApp         app rows the statement doesn't show (duplicates, rows the
 *                     issuer moved to another cycle…)
 *
 * Matching is greedy in tiers, strictest first. Amount is the anchor: within a
 * single bill an exact amount collision on different purchases is rare, and
 * date/installment/card metadata disambiguates the rest.
 */

export interface StatementLine {
  date: string; // yyyy-mm-dd (parceladas keep the original purchase date)
  description: string;
  amount: number; // signed: estornos negative
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
}

export interface AppLine {
  id: string;
  date: string;
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  source: string; // 'pluggy' | 'manual'
  category: string | null;
}

export interface AmountMismatch {
  statement: StatementLine;
  app: AppLine;
  /** statement.amount - app.amount (what the app must add to agree). */
  diff: number;
}

export interface ReconcileResult {
  matched: Array<{ statement: StatementLine; app: AppLine }>;
  amountMismatches: AmountMismatch[];
  missingInApp: StatementLine[];
  onlyInApp: AppLine[];
}

/** Payment rows live in the transactions table but are not statement lançamentos. */
const PAYMENT_RE = /pagamento\s+(de\s+fatura|recebido)/i;

export function isPaymentLine(description: string | null): boolean {
  return PAYMENT_RE.test(description ?? '');
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Lowercase alphanumerics only — survives casing/punctuation/truncation noise. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Loose same-merchant check. Statements truncate differently than the app
 * ("171 - RIACHUELPARC01/03" vs "171 - Riachuelo - Sb C Sao Bernardo Bra"),
 * so compare a normalized prefix instead of the whole string.
 */
export function descSimilar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na.length === 0 || nb.length === 0) return false;
  const n = Math.min(na.length, nb.length, 8);
  return na.slice(0, n) === nb.slice(0, n);
}

function sameInstallment(a: StatementLine, b: AppLine): boolean {
  return (
    a.installmentNumber != null &&
    a.installmentNumber === b.installmentNumber &&
    a.totalInstallments === b.totalInstallments
  );
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000;
}

type Pair = { statement: StatementLine; app: AppLine };

/**
 * One greedy pass: for each unmatched statement line, pick the best unmatched
 * app row accepted by `accept`. Preference order: same card, then closest date.
 */
function pass(
  statement: Set<StatementLine>,
  app: Set<AppLine>,
  accept: (s: StatementLine, a: AppLine) => boolean,
): Pair[] {
  const pairs: Pair[] = [];
  for (const s of statement) {
    let best: AppLine | null = null;
    let bestScore = -Infinity;
    for (const a of app) {
      if (!accept(s, a)) continue;
      const cardBonus = s.cardLast4 != null && s.cardLast4 === a.cardLast4 ? 1000 : 0;
      const score = cardBonus - dayDiff(s.date, a.date);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (best) {
      pairs.push({ statement: s, app: best });
      statement.delete(s);
      app.delete(best);
    }
  }
  return pairs;
}

/** Cent-drift tolerance: manual installment rounding is off by a few centavos. */
const MISMATCH_TOLERANCE = 0.15;

export function reconcileFatura(
  statementLines: StatementLine[],
  appLines: AppLine[],
): ReconcileResult {
  // Payments are not lançamentos: the extractor is told to skip them, and the
  // app keeps them uncategorized. Drop both sides defensively.
  const statement = new Set(statementLines.filter((s) => !isPaymentLine(s.description)));
  const app = new Set(appLines.filter((a) => !isPaymentLine(a.description)));

  const sameAmount = (s: StatementLine, a: AppLine) => r2(s.amount) === r2(a.amount);

  const matched: Pair[] = [
    // 1. Same value on the same day.
    ...pass(statement, app, (s, a) => sameAmount(s, a) && s.date === a.date),
    // 2. Same value + same installment X/Y — parceladas keep the original
    //    purchase date on the statement but a window date in the app.
    ...pass(statement, app, (s, a) => sameAmount(s, a) && sameInstallment(s, a)),
    // 3. Same value a few days apart (posting delay).
    ...pass(statement, app, (s, a) => sameAmount(s, a) && dayDiff(s.date, a.date) <= 3),
    // 4. Same value anywhere in the window, same merchant.
    ...pass(statement, app, (s, a) => sameAmount(s, a) && descSimilar(s.description, a.description)),
  ];

  // 5. Cent drift: same purchase (installment pair or same-day + merchant),
  //    value within a few centavos.
  const nearAmount = (s: StatementLine, a: AppLine) =>
    Math.abs(s.amount - a.amount) <= MISMATCH_TOLERANCE &&
    Math.sign(s.amount) === Math.sign(a.amount);
  const amountMismatches: AmountMismatch[] = [
    ...pass(
      statement,
      app,
      (s, a) => nearAmount(s, a) && sameInstallment(s, a) && descSimilar(s.description, a.description),
    ),
    ...pass(
      statement,
      app,
      (s, a) => nearAmount(s, a) && dayDiff(s.date, a.date) <= 3 && descSimilar(s.description, a.description),
    ),
  ].map((p) => ({ ...p, diff: r2(p.statement.amount - p.app.amount) }));

  return {
    matched,
    amountMismatches,
    missingInApp: [...statement],
    onlyInApp: [...app],
  };
}
