/**
 * Response shapes of the @finance/api backend, redeclared here to mirror what
 * each endpoint returns. There is no shared package between the two workspaces
 * (see CLAUDE.md) — these are a hand-kept mirror, so a backend change that is
 * not reflected here compiles fine and fails at runtime.
 *
 * Types only, with one exception noted at `cardGroupFilterToQuery`.
 */

// ── Types: items, accounts, cards ──

export interface Item {
  id: string;
  connector_name: string | null;
  created_at: string;
}

export interface Account {
  id: string;
  itemId: string;
  name: string | null;
  number: string | null;
  type: string | null;
  syncedAt: string;
}

export interface AccountSettings {
  account_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  usage_count: number;
  created_at: string;
}

export interface CardGroup {
  id: number;
  item_id: string;
  account_id: string | null;
  name: string;
  color: string;
  memberCount: number;
  created_at: string;
  updated_at: string;
}

export interface Card {
  cardLast4: string;
  txCount: number;
  lastUsed: string;
  group: { id: number; name: string; color: string } | null;
}

/**
 * Frontend-wide filter state for "which cards should I see?".
 * 'all' → no filter, show everything
 * 'none' → show only transactions from cards with no group
 * number → show only that group
 */
export type CardGroupFilter = 'all' | 'none' | number;

/**
 * The one runtime value in this file. It lives here rather than in api.ts
 * because it is the encoding of the union above — the two have to change
 * together, and splitting them would mean reading two files to know how
 * 'none' reaches the wire.
 */
export function cardGroupFilterToQuery(f: CardGroupFilter): string | undefined {
  if (f === 'all') return undefined;
  if (f === 'none') return 'none';
  return String(f);
}

// ── Types: transactions and learned rules ──

export interface UserCategoryRef {
  id: number;
  name: string;
  color: string;
  assignedBy: 'manual' | 'bulk' | 'learned' | null;
}

export interface Transaction {
  id: string;
  /** The Pluggy-issued ID. Non-unique: Pluggy recycles IDs across different purchases. */
  providerTransactionId: string | null;
  accountId: string;
  itemId: string;
  date: string; // yyyy-mm-dd
  description: string | null;
  amount: number;
  currencyCode: string | null;
  pluggyCategory: string | null;
  type: string | null;
  status: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  billId: string | null;
  cardLast4: string | null;
  /** -1 = pulled from next cycle, +1 = pushed from previous cycle, null = unshifted */
  billShift: -1 | 1 | null;
  /** 'pluggy' for synced transactions, 'manual' for user-created entries */
  source: 'pluggy' | 'manual';
  /** 'half' = 50/50 split, 'theirs' = partner owes 100%, null = not split (implicitly mine) */
  split: 'half' | 'theirs' | null;
  /** Hidden from the bill: excluded from every total/breakdown/split/reconcile computation. */
  hidden: boolean;
  userCategory: UserCategoryRef | null;
}

export interface Rule {
  id: number;
  merchant_slug: string;
  hit_count: number;
  override_count: number;
  disabled: number;
  user_category_id: number;
  user_category_name: string;
  user_category_color: string;
  created_at: string;
}

// ── Types: bills ──

export interface BillCategoryBreakdown {
  id: number;
  name: string;
  color: string;
  total: number;
  /** Same-category total for the previous bill cycle (0 when absent). */
  previousTotal: number;
}

export interface BillInstallmentBreakdown {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  installmentNumber: number;
  totalInstallments: number;
}

export interface BillBreakdown {
  itemId: string;
  accountId: string | null;
  displayName: string | null;
  /** 0 = currently open bill, -N = N cycles in the past. Echoed back from the request. */
  offset: number;
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  /** Adjacent windows — needed so callers can ask /transactions for a shift-aware list. */
  previousPeriodStart: string;
  previousPeriodEnd: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
  total: number;
  previousTotal: number;
  delta: number;
  categories: BillCategoryBreakdown[];
  installments: BillInstallmentBreakdown[];
  /** True when the immediately following bill window has any transactions
   *  (shift-aware). Drives whether the "→" arrow is enabled. */
  hasNextBillTransactions: boolean;
}

// ── Types: cash flow ──

export interface ManualEntry {
  id: number;
  description: string;
  amount: number;
  dayOfMonth: number;
  month: string;
  active: boolean;
  createdAt: string;
}

export interface CashFlowEntry {
  id: string;
  description: string;
  amount: number;
  type: 'bank_transaction' | 'manual_entry' | 'credit_card_bill';
  accountId?: string;
  bankAccountId?: string;
  isBillPayment?: boolean;
  hidden?: boolean;
}

export interface CashFlowDay {
  date: string;
  isPast: boolean;
  entries: CashFlowEntry[];
}

export interface CashFlowBankAccount {
  id: string;
  name: string | null;
  balance: number | null;
  openingBalance: number | null;
}

export interface CashFlowResponse {
  month: string;
  bankAccounts: CashFlowBankAccount[];
  days: CashFlowDay[];
}

// ── Types: split summary ──

export interface SplitSummaryTransaction {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  splitType: 'half' | 'theirs';
  owes: number;
  installmentNumber: number | null;
  totalInstallments: number | null;
}

export interface SplitCategoryBreakdown {
  id: number;
  name: string;
  color: string;
  halfTotal: number;
  theirsTotal: number;
  mineTotal: number;
  total: number;
  /** Same-category totals for the previous bill cycle (0 when absent). */
  prevHalfTotal: number;
  prevTheirsTotal: number;
  prevMineTotal: number;
}

export interface SplitInstallmentBreakdown {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  splitType: 'half' | 'theirs' | 'mine';
  installmentNumber: number;
  totalInstallments: number;
  /** Category of the underlying transaction — drives the "por categoria" view. */
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface SplitSummary {
  accountId: string;
  offset: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  totalSplitTransactions: number;
  partnerOwes: number;
  /** Previous-cycle share totals — drive the "vs anterior" delta under the headline. */
  previousPartnerOwes: number;
  previousMyShare: number;
  breakdown: {
    half: { count: number; total: number; owes: number };
    theirs: { count: number; total: number; owes: number };
    mine: { count: number; total: number };
  };
  /** Previous-cycle equivalents — drive the "vs anterior" delta per column. */
  previousBreakdown: {
    half: { total: number; owes: number };
    theirs: { total: number; owes: number };
    mine: { total: number };
  };
  categories: SplitCategoryBreakdown[];
  installments: SplitInstallmentBreakdown[];
  transactions: SplitSummaryTransaction[];
}

// ── Types: partner cards (read-only) ──

export interface PartnerCard {
  ownerUsername: string;
  accountId: string;
  accountName: string | null;
  accountNumber: string | null;
  itemId: string;
  connectorName: string | null;
  displayName: string | null;
  closingDay: number;
  dueDay: number;
}

export interface PartnerCardTransaction {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  owes: number;
  splitType: 'half' | 'theirs';
  installmentNumber: number | null;
  totalInstallments: number | null;
  category: { id: number; name: string; color: string } | null;
}

export interface PartnerCardBreakdown {
  ownerUsername: string;
  accountId: string;
  itemId: string;
  accountName: string | null;
  connectorName: string | null;
  displayName: string | null;
  closingDay: number;
  dueDay: number;
  offset: number;
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  total: number;
  previousTotal: number;
  delta: number;
  categories: PartnerCardCategory[];
  transactions: PartnerCardTransaction[];
}

export interface PartnerCardCategory {
  id: number;
  name: string;
  color: string;
  /** Viewer's owed share from ½ transactions (amount/2 summed). */
  halfTotal: number;
  /** Viewer's owed share from "dela" transactions (full amount summed). */
  theirsTotal: number;
  /** halfTotal + theirsTotal. */
  total: number;
}

// ── Types: fatura import and reconciliation ──

/** A transaction extracted from fatura screenshots, pending review/insert. */
export interface ExtractedFaturaRow {
  date: string;
  description: string;
  /** Signed: refunds (estornos) are negative. */
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  isRefund: boolean;
  /** Shift to land this row in the bill being viewed (0 = natural cycle). */
  billShift: number;
}

/** A statement line from the closed-bill PDF, as read by the model. */
export interface StatementLine {
  /** The line exactly as printed, so the reading can be audited. */
  quote: string;
  date: string;
  description: string;
  /** Signed: estornos negative. */
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  /** The model's remark on an unpaired line, if any. */
  note: string | null;
}

/** An app transaction inside the reconciled bill window. */
export interface ReconcileAppLine {
  id: string;
  date: string;
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  source: string;
  category: string | null;
}

/** Statement line missing from the app, annotated ready for insertion. */
export interface ReconcileMissingRow extends StatementLine {
  /** Original statement date (`date` may have been re-dated to the closing date). */
  statementDate: string;
  billShift: number;
}

export interface ReconcileReport {
  window: { periodStart: string; periodEnd: string; nextDueDate: string };
  /** Sum of categorized app rows — mirrors the bill headline. */
  appBillTotal: number;
  /** The statement's net total as printed (picked by the model), else the line sum. */
  statementTotal: number;
  /** The printed label of that figure, e.g. "Total da fatura". */
  statementTotalLabel: string | null;
  /** The model's one-sentence reason that figure is the net one. */
  statementTotalReasoning: string;
  /** Where statementTotal came from: the PDF's summary box, or the read lines. */
  statementTotalSource: 'printed' | 'rows';
  /** Sum of the lines the model read — computed by the API, not the model. */
  statementRowsTotal: number;
  /** "Total de encargos" (juros/multa/IOF), when the statement charges any. */
  statementCharges: number | null;
  /** appBillTotal - statementTotal. */
  delta: number;
  matchedCount: number;
  missingInApp: ReconcileMissingRow[];
  amountMismatches: Array<{
    statement: StatementLine;
    app: ReconcileAppLine;
    /** statement - app: what the app row must gain to agree. */
    diff: number;
  }>;
  onlyInApp: Array<ReconcileAppLine & { reason: string }>;
  /** Checks the model's answer failed (Portuguese, ready to show). */
  warnings: string[];
}

/** The payload the user confirms for insertion. */
export interface CommitFaturaRow {
  date: string;
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  billShift: number;
}
