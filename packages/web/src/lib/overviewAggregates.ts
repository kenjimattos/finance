/**
 * Pure aggregations behind the Overview. Every figure summed here was already
 * computed by the API (bill totals, split shares, cash balances); these only
 * combine one month's per-card responses into the screen's totals. Domain
 * rules — which cycle is due, what a bill payment is, how a balance is
 * reached — stay in the API (see docs/frontend.md, "Client or server").
 */

import type {
  BillBreakdown,
  CashFlowEntry,
  CashFlowResponse,
  PartnerCardBreakdown,
  SplitSummary,
} from './apiTypes';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Cash ───────────────────────────────────────────────────────────

/**
 * A card-bill outflow: a bank row tagged as a bill payment (the sync
 * auto-tags new rows by description; the user toggles it in CashFlow), or a
 * projected bill on its due date.
 */
const isCardBill = (e: CashFlowEntry) =>
  (e.type === 'bank_transaction' && !!e.isBillPayment) || e.type === 'credit_card_bill';

/**
 * The Caixa headline for one month. Hidden bank rows are display-only — the
 * API returns them flagged `hidden` so CashFlow can offer a restore toggle,
 * but they never contribute to any balance; summing them would double-count
 * the duplicates the user hid on purpose.
 *
 * Balances come from the API: past/current months show the saldo as of the
 * last realized day, future months the projected end of the month.
 */
export function summarizeCashMonth(data: CashFlowResponse, isFutureMonth: boolean) {
  let income = 0;
  let expenses = 0;
  let cardBills = 0;
  for (const day of data.days) {
    for (const e of day.entries) {
      if (e.hidden) continue;
      if (e.amount > 0) income += e.amount;
      else expenses += e.amount;
      if (e.amount < 0 && isCardBill(e)) cardBills += e.amount;
    }
  }
  const lastRealized = data.days.filter((d) => d.isPast).at(-1);
  return {
    currentBalance: isFutureMonth
      ? data.closingBalance
      : (lastRealized?.balance ?? data.openingBalance),
    income: round2(income),
    expenses: round2(expenses - cardBills),
    cardBills: round2(cardBills),
  };
}

/** Outflows that are not card bills — the "saídas" figure, for the vs-previous delta. */
export function nonBillExpenses(data: CashFlowResponse): number {
  let expenses = 0;
  let cardBills = 0;
  for (const day of data.days) {
    for (const e of day.entries) {
      if (e.hidden || e.amount >= 0) continue;
      expenses += e.amount;
      if (isCardBill(e)) cardBills += e.amount;
    }
  }
  return round2(expenses - cardBills);
}

/**
 * Does the month have anything real to look at? Enables the Overview's "→".
 * Counts bank transactions and user-authored manual entries only: projected
 * bill outflows are derived and would keep the arrow permanently enabled.
 */
export function hasRealEntries(data: CashFlowResponse | undefined): boolean {
  return (data?.days ?? []).some((day) =>
    day.entries.some(
      (e) => !e.hidden && (e.type === 'bank_transaction' || e.type === 'manual_entry'),
    ),
  );
}

// ─── Cards ──────────────────────────────────────────────────────────

/** Grand total, delta and category breakdown across every card's bill. */
export function sumBillBreakdowns(breakdowns: BillBreakdown[]) {
  let total = 0;
  let delta = 0;
  const map = new Map<number, { id: number; name: string; color: string; total: number; previousTotal: number }>();
  for (const b of breakdowns) {
    total += b.total;
    delta += b.delta;
    for (const cat of b.categories) {
      const existing = map.get(cat.id);
      if (existing) {
        existing.total += cat.total;
        existing.previousTotal += cat.previousTotal;
      } else {
        map.set(cat.id, { ...cat });
      }
    }
  }
  return {
    total,
    delta,
    categories: Array.from(map.values()).sort((a, b) => b.total - a.total),
  };
}

// ─── Partner cards ──────────────────────────────────────────────────

/**
 * Partner-card categories across every shared card, keeping the ½ (metade)
 * and dela portions separate so each can be shown on its own.
 */
export function sumPartnerCategories(breakdowns: PartnerCardBreakdown[]) {
  const map = new Map<
    number,
    { id: number; name: string; color: string; halfTotal: number; theirsTotal: number }
  >();
  let halfTotal = 0;
  let theirsTotal = 0;
  for (const b of breakdowns) {
    for (const cat of b.categories) {
      halfTotal += cat.halfTotal;
      theirsTotal += cat.theirsTotal;
      const existing = map.get(cat.id);
      if (existing) {
        existing.halfTotal += cat.halfTotal;
        existing.theirsTotal += cat.theirsTotal;
      } else {
        map.set(cat.id, {
          id: cat.id,
          name: cat.name,
          color: cat.color,
          halfTotal: cat.halfTotal,
          theirsTotal: cat.theirsTotal,
        });
      }
    }
  }
  const categories = Array.from(map.values())
    .map((c) => ({
      ...c,
      halfTotal: round2(c.halfTotal),
      theirsTotal: round2(c.theirsTotal),
      total: round2(c.halfTotal + c.theirsTotal),
    }))
    .sort((a, b) => b.total - a.total);
  return {
    categories,
    halfTotal: round2(halfTotal),
    theirsTotal: round2(theirsTotal),
    grandTotal: round2(halfTotal + theirsTotal),
  };
}

export interface PartnerInstallmentItem {
  id: string;
  description: string | null;
  owes: number;
  installmentNumber: number;
  totalInstallments: number;
}

/**
 * Installment ("parcela") transactions across every shared card, split by ½
 * vs dela so each column lists its own. `owes` is the viewer's share for that
 * installment (half/2 or full).
 */
export function partnerInstallments(breakdowns: PartnerCardBreakdown[]) {
  const half: PartnerInstallmentItem[] = [];
  const theirs: PartnerInstallmentItem[] = [];
  for (const b of breakdowns) {
    for (const t of b.transactions) {
      if (t.installmentNumber == null || t.totalInstallments == null) continue;
      const item: PartnerInstallmentItem = {
        id: t.id,
        description: t.description,
        owes: t.owes,
        installmentNumber: t.installmentNumber,
        totalInstallments: t.totalInstallments,
      };
      if (t.splitType === 'half') half.push(item);
      else theirs.push(item);
    }
  }
  return { half, theirs };
}

// ─── Splits ─────────────────────────────────────────────────────────

/**
 * Every card's split summary for the month, summed field by field into the
 * shape SplitSection renders. `null` when no card has a split transaction.
 */
export function sumSplitSummaries(summaries: SplitSummary[]) {
  let partnerOwes = 0;
  let previousPartnerOwes = 0;
  let previousMyShare = 0;
  let totalCount = 0;
  let halfCount = 0;
  let halfTotal = 0;
  let halfOwes = 0;
  let theirsCount = 0;
  let theirsTotal = 0;
  let theirsOwes = 0;
  let mineCount = 0;
  let mineTotal = 0;
  let prevHalfTotal = 0;
  let prevHalfOwes = 0;
  let prevTheirsTotal = 0;
  let prevTheirsOwes = 0;
  let prevMineTotal = 0;
  const catMap = new Map<number, { id: number; name: string; color: string; halfTotal: number; theirsTotal: number; mineTotal: number; prevHalfTotal: number; prevTheirsTotal: number; prevMineTotal: number }>();
  const installments: SplitSummary['installments'] = [];

  for (const s of summaries) {
    partnerOwes += s.partnerOwes;
    previousPartnerOwes += s.previousPartnerOwes;
    previousMyShare += s.previousMyShare;
    totalCount += s.totalSplitTransactions;
    halfCount += s.breakdown.half.count;
    halfTotal += s.breakdown.half.total;
    halfOwes += s.breakdown.half.owes;
    theirsCount += s.breakdown.theirs.count;
    theirsTotal += s.breakdown.theirs.total;
    theirsOwes += s.breakdown.theirs.owes;
    mineCount += s.breakdown.mine.count;
    mineTotal += s.breakdown.mine.total;
    prevHalfTotal += s.previousBreakdown.half.total;
    prevHalfOwes += s.previousBreakdown.half.owes;
    prevTheirsTotal += s.previousBreakdown.theirs.total;
    prevTheirsOwes += s.previousBreakdown.theirs.owes;
    prevMineTotal += s.previousBreakdown.mine.total;
    for (const cat of s.categories) {
      const existing = catMap.get(cat.id);
      if (existing) {
        existing.halfTotal += cat.halfTotal;
        existing.theirsTotal += cat.theirsTotal;
        existing.mineTotal += cat.mineTotal;
        existing.prevHalfTotal += cat.prevHalfTotal;
        existing.prevTheirsTotal += cat.prevTheirsTotal;
        existing.prevMineTotal += cat.prevMineTotal;
      } else {
        catMap.set(cat.id, {
          id: cat.id,
          name: cat.name,
          color: cat.color,
          halfTotal: cat.halfTotal,
          theirsTotal: cat.theirsTotal,
          mineTotal: cat.mineTotal,
          prevHalfTotal: cat.prevHalfTotal,
          prevTheirsTotal: cat.prevTheirsTotal,
          prevMineTotal: cat.prevMineTotal,
        });
      }
    }
    installments.push(...s.installments);
  }

  if (totalCount === 0) return null;

  return {
    partnerOwes: round2(partnerOwes),
    previousPartnerOwes: round2(previousPartnerOwes),
    previousMyShare: round2(previousMyShare),
    totalCount,
    breakdown: {
      half: { count: halfCount, total: round2(halfTotal), owes: round2(halfOwes) },
      theirs: { count: theirsCount, total: round2(theirsTotal), owes: round2(theirsOwes) },
      mine: { count: mineCount, total: round2(mineTotal) },
    },
    previousBreakdown: {
      half: { total: round2(prevHalfTotal), owes: round2(prevHalfOwes) },
      theirs: { total: round2(prevTheirsTotal), owes: round2(prevTheirsOwes) },
      mine: { total: round2(prevMineTotal) },
    },
    categories: Array.from(catMap.values())
      .map((c) => ({
        ...c,
        halfTotal: round2(c.halfTotal),
        theirsTotal: round2(c.theirsTotal),
        mineTotal: round2(c.mineTotal),
        total: round2(c.halfTotal + c.theirsTotal + c.mineTotal),
        prevHalfTotal: round2(c.prevHalfTotal),
        prevTheirsTotal: round2(c.prevTheirsTotal),
        prevMineTotal: round2(c.prevMineTotal),
      }))
      .sort((a, b) => b.total - a.total),
    installments,
  };
}
