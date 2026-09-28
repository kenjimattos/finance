import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import type {
  Item,
  Account,
  AccountSettings,
  CashFlowResponse,
  SplitSummary,
} from '../lib/apiTypes';
import { formatBRL, formatDelta } from '../lib/format';
import { findOffsetForDueMonth, currentDueMonth } from '../lib/billWindow';
import { SplitSection } from '../components/SplitSection';
import { ThemeToggle } from '../components/ThemeToggle';
import { useIsDemo } from '../lib/useIsDemo';
import { keys } from '../lib/queryKeys';
import { SyncAllButton } from '../components/overview/SyncAllButton';
import { CategoryBreakdown } from '../components/overview/CategoryBreakdown';
import { AccountCard, UnconfiguredCard } from '../components/overview/AccountCard';
import {
  PartnerAccountCard,
  PartnerCategoryColumn,
  type PartnerInstallmentItem,
} from '../components/overview/PartnerCards';
import { ManageBankButton } from '../components/overview/ManageBankButton';
import { addMonth, monthStr } from '../lib/month';

// ─── Month label ────────────────────────────────────────────────────

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// ─── Types ──────────────────────────────────────────────────────────

interface AccountWithSettings {
  item: Item;
  account: Account;
  settings: AccountSettings;
}

// ─── Overview ───────────────────────────────────────────────────────

export function Overview({
  items,
  targetMonth: controlledMonth,
  onMonthChange,
  onSelectAccount,
  onSelectPartnerCard,
  onOpenCashFlow,
}: {
  items: Item[];
  /** Controlled month state — persisted in App so "voltar" restores it. */
  targetMonth: { year: number; month: number } | null;
  onMonthChange: (m: { year: number; month: number }) => void;
  onSelectAccount: (itemId: string, accountId: string, offset: number) => void;
  onSelectPartnerCard: (owner: string, accountId: string, offset: number) => void;
  onOpenCashFlow: () => void;
}) {
  const today = useMemo(() => new Date(), []);
  const isDemo = useIsDemo();

  // ── Gather all accounts + settings across all items ──

  const accountQueries = useQueries({
    queries: items.map((item) => ({
      queryKey: keys.accounts.ofItem(item.id),
      queryFn: () => api.listAccounts(item.id),
    })),
  });

  const allAccounts = useMemo(() => {
    const result: { item: Item; account: Account }[] = [];
    accountQueries.forEach((q, i) => {
      if (!q.data) return;
      const item = items[i];
      q.data
        .filter((a) => a.type === 'CREDIT')
        .forEach((account) => result.push({ item, account }));
    });
    return result;
  }, [accountQueries, items]);

  const allAccountsAnyType = useMemo(() => {
    const result: { item: Item; account: Account }[] = [];
    accountQueries.forEach((q, i) => {
      if (!q.data) return;
      const item = items[i];
      q.data.forEach((account) => result.push({ item, account }));
    });
    return result;
  }, [accountQueries, items]);

  const settingsQueries = useQueries({
    queries: allAccounts.map(({ account }) => ({
      queryKey: keys.accountSettings.of(account.id),
      queryFn: () => api.getAccountSettings(account.id),
      retry: false,
    })),
  });

  // Separate accounts into configured (have settings) and unconfigured (need setup).
  const { configured, unconfigured } = useMemo(() => {
    const configured: AccountWithSettings[] = [];
    const unconfigured: { item: Item; account: Account }[] = [];
    allAccounts.forEach(({ item, account }, i) => {
      const sq = settingsQueries[i];
      if (sq?.data) {
        configured.push({ item, account, settings: sq.data });
      } else if (sq?.isError) {
        // 404 = no settings yet → needs setup
        unconfigured.push({ item, account });
      }
    });
    return { configured, unconfigured };
  }, [allAccounts, settingsQueries]);

  // ── Target month (initialized from the first account's current due month) ──

  const defaultMonth = useMemo(() => {
    // if (configured.length === 0)
      return { year: today.getFullYear(), month: today.getMonth() + 1};
    // const s = configured[0].settings;
    // return currentDueMonth({ closingDay: s.closing_day, dueDay: s.due_day }, today);
  }, [configured, today]);

  const year = controlledMonth?.year ?? defaultMonth.year;
  const month = controlledMonth?.month ?? defaultMonth.month;

  const isCurrentMonth =
    year === defaultMonth.year && month === defaultMonth.month;

  const isFutureMonth =
    year > defaultMonth.year || (year === defaultMonth.year && month > defaultMonth.month);

  function navigateMonth(delta: number) {
    const next = addMonth(year, month, delta);
    onMonthChange(next);
  }

  // ── Cash flow summary for the target month ──

  const ms = monthStr(year, month);
  const prevM = addMonth(year, month, -1);
  const prevMs = monthStr(prevM.year, prevM.month);
  const nextM = addMonth(year, month, 1);
  const nextMs = monthStr(nextM.year, nextM.month);

  const cashflowQ = useQuery({
    queryKey: keys.cashflow.month(ms),
    queryFn: () => api.getCashFlow(ms),
  });
  const prevCashflowQ = useQuery({
    queryKey: keys.cashflow.month(prevMs),
    queryFn: () => api.getCashFlow(prevMs),
  });
  // Probe the NEXT month so the "→" arrow can enable only when there's
  // something to navigate to (bank transactions, manual entries, or
  // credit card bill projections).
  const nextCashflowQ = useQuery({
    queryKey: keys.cashflow.month(nextMs),
    queryFn: () => api.getCashFlow(nextMs),
  });

  // A card-bill outflow: a bank row tagged as a bill payment (the sync
  // auto-tags new rows by description; the user toggles it in CashFlow), or a
  // projected bill on its due date.
  type CashEntry = CashFlowResponse['days'][number]['entries'][number];
  const isCardBill = (e: CashEntry) =>
    (e.type === 'bank_transaction' && !!e.isBillPayment) || e.type === 'credit_card_bill';

  const cashSummary = useMemo(() => {
    const data = cashflowQ.data;
    if (!data) return null;

    let income = 0;
    let expenses = 0;
    let cardBills = 0;

    for (const day of data.days) {
      for (const e of day.entries) {
        // Hidden bank rows are display-only — the API returns them flagged
        // `hidden` so CashFlow can offer a restore toggle, but they never
        // contribute to any balance (the server's openingBalance walk skips
        // them too). Summing them here double-counts the duplicates the user
        // hid on purpose.
        if (e.hidden) continue;
        if (e.amount > 0) income += e.amount;
        else expenses += e.amount;
        if (e.amount < 0 && isCardBill(e)) cardBills += e.amount;
      }
    }
    // * MARK: Cálculo do saldo
    // Balances come from the API. Past/current months show the saldo as of
    // the last realized day; future months, the projected end of the month.
    const lastRealized = data.days.filter((d) => d.isPast).at(-1);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      openingBalance: data.openingBalance,
      currentBalance: isFutureMonth
        ? data.closingBalance
        : (lastRealized?.balance ?? data.openingBalance),
      income: round2(income),
      expenses: round2(expenses - cardBills),
      cardBills: round2(cardBills),
    };
  }, [cashflowQ.data, isFutureMonth]);

  const prevCashSummary = useMemo(() => {
    const data = prevCashflowQ.data;
    if (!data) return null;
    let expenses = 0;
    let cardBills = 0;
    for (const day of data.days) {
      for (const e of day.entries) {
        if (e.hidden || e.amount >= 0) continue;
        expenses += e.amount;
        if (isCardBill(e)) cardBills += e.amount;
      }
    }
    return { expenses: Math.round((expenses - cardBills) * 100) / 100 };
  }, [prevCashflowQ.data]);

  // ── Resolve offset per account and fetch breakdowns in parallel ──

  const accountOffsets = useMemo(
    () =>
      configured.map(({ settings }) => {
        const cs = { closingDay: settings.closing_day, dueDay: settings.due_day };
        return findOffsetForDueMonth(cs, year, month, today);
      }),
    [configured, year, month, today],
  );

  const breakdownQueries = useQueries({
    queries: configured.map(({ item, account }, i) => {
      const offset = accountOffsets[i];
      return {
        queryKey: keys.billBreakdown.at(item.id, account.id, offset),
        queryFn: () => api.getBillBreakdown(item.id, account.id, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  // ── Partner shared cards (read-only) ──

  const partnerCardsQ = useQuery({
    queryKey: keys.partnerCards(),
    queryFn: api.listPartnerCards,
  });

  const partnerCards = partnerCardsQ.data ?? [];

  const partnerOffsets = useMemo(
    () =>
      partnerCards.map((c) => {
        const cs = { closingDay: c.closingDay, dueDay: c.dueDay };
        return findOffsetForDueMonth(cs, year, month, today);
      }),
    [partnerCards, year, month, today],
  );

  const partnerBreakdownQueries = useQueries({
    queries: partnerCards.map((c, i) => {
      const offset = partnerOffsets[i];
      return {
        queryKey: keys.partnerCardBreakdown.at(c.ownerUsername, c.accountId, offset),
        queryFn: () => api.getPartnerCardBreakdown(c.ownerUsername, c.accountId, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  // Aggregate partner-card categories across every shared card, keeping the
  // ½ (metade) and dela portions separate so each can be shown on its own.
  const partnerCategorySummary = useMemo(() => {
    const map = new Map<
      number,
      { id: number; name: string; color: string; halfTotal: number; theirsTotal: number }
    >();
    let halfTotal = 0;
    let theirsTotal = 0;
    for (const q of partnerBreakdownQueries) {
      if (!q.data) continue;
      for (const cat of q.data.categories) {
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
    const round2 = (n: number) => Math.round(n * 100) / 100;
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
  }, [partnerBreakdownQueries]);

  // Installment ("parcela") transactions across every shared card, kept
  // split by ½ vs dela so each column lists its own. `owes` is the viewer's
  // share for that installment (half/2 or full).
  const partnerInstallments = useMemo(() => {
    const half: PartnerInstallmentItem[] = [];
    const theirs: PartnerInstallmentItem[] = [];
    for (const q of partnerBreakdownQueries) {
      if (!q.data) continue;
      for (const t of q.data.transactions) {
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
  }, [partnerBreakdownQueries]);

  // ── Split summaries across all configured accounts ──

  const splitQueries = useQueries({
    queries: configured.map(({ account }, i) => {
      const offset = accountOffsets[i];
      return {
        queryKey: keys.splitSummary.at(account.id, offset),
        queryFn: () => api.getSplitSummary(account.id, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  const aggregatedSplit = useMemo(() => {
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

    for (const q of splitQueries) {
      const s = q.data;
      if (!s) continue;
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

    const round2 = (n: number) => Math.round(n * 100) / 100;
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
  }, [splitQueries]);

  // ── Grand total (categorized only — matches per-account totals) ──

  const { grandTotal, grandDelta } = useMemo(() => {
    let total = 0;
    let delta = 0;
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      total += q.data.total;
      delta += q.data.delta;
    });
    return { grandTotal: total, grandDelta: delta };
  }, [breakdownQueries]);

  // ── Aggregated category breakdown across all accounts ──

  const aggregatedCategories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string; total: number; previousTotal: number }>();
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      for (const cat of q.data.categories) {
        const existing = map.get(cat.id);
        if (existing) {
          existing.total += cat.total;
          existing.previousTotal += cat.previousTotal;
        } else {
          map.set(cat.id, { ...cat });
        }
      }
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [breakdownQueries]);

  // Is there anything to see in the NEXT month? Enables the "→" arrow.
  // Criterion: the next month's cashflow has a real bank transaction
  // (realized) or a user-authored manual entry. Card activity is NOT part of
  // this decision — projected bill outflows (`credit_card_bill`) are derived
  // and would keep the arrow permanently enabled; Dashboard already gates bill
  // navigation on its own `hasNextBillTransactions`.
  const hasEntriesInNextMonth = useMemo(() => {
    return (nextCashflowQ.data?.days ?? []).some((day) =>
      day.entries.some(
        (e) =>
          !e.hidden &&
          (e.type === 'bank_transaction' || e.type === 'manual_entry'),
      ),
    );
  }, [nextCashflowQ.data]);

  const loading =
    accountQueries.some((q) => q.isLoading) ||
    settingsQueries.some((q) => q.isLoading);

  // *MARK: ── Render ──

  const expensesDelta = cashSummary && prevCashSummary
    ? formatDelta(cashSummary.expenses - prevCashSummary.expenses)
    : null;
  const expensesDeltaDir = cashSummary && prevCashSummary
    ? (cashSummary.expenses - prevCashSummary.expenses) < -0.01 ? 'higher'
      : (cashSummary.expenses - prevCashSummary.expenses) > 0.01 ? 'lower'
      : 'flat'
    : 'flat';

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Month navigation header */}
      <div className="mb-12">
        <div className="flex items-baseline justify-between gap-4">
          <div className="eyebrow flex items-center gap-3" data-tour="month-nav">
            <button
              type="button"
              onClick={() => navigateMonth(-1)}
              aria-label="mês anterior"
              className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none"
            >
              ←
            </button>
            <span className="uppercase">{monthLabel(year, month)}</span>
            <button
              type="button"
              onClick={() => navigateMonth(1)}
              disabled={!hasEntriesInNextMonth}
              aria-label="próximo mês"
              className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:text-[color:var(--color-ink-faint)] disabled:opacity-40"
            >
              →
            </button>
          </div>
          <div className="flex items-center gap-4">
            {!isDemo && <SyncAllButton items={items} />}
            {!isDemo && <ManageBankButton items={items} accounts={allAccountsAnyType} />}
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* ═══ CAIXA ═══ */}
      <div className="mb-14" data-tour="caixa">
        <div className="eyebrow mb-6 uppercase">caixa</div>

        {cashflowQ.isLoading ? (
          <div className="h-24 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
        ) : cashSummary ? (
          <div>
            {/* Saldo headline */}
            <div className="font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]">
              {formatBRL(cashSummary.currentBalance)}
            </div>
            <div className="mt-2 flex items-baseline gap-4">
              <p className="font-body text-sm text-[color:var(--color-ink-muted)]">
                saldo {isFutureMonth ? 'projetado' : isCurrentMonth ? 'atual' : 'final'}
              </p>
              <button
                type="button"
                onClick={onOpenCashFlow}
                className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
              >
                ver extrato →
              </button>
            </div>

            {/* Entradas / Saídas / Faturas */}
            <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
              <div>
                <div className="font-body text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)]">
                  entradas
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-positive)]">
                  {formatBRL(cashSummary.income)}
                </div>
              </div>
              <div>
                <div className="font-body text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)]">
                  saídas
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-ink)]">
                  {formatBRL(Math.abs(cashSummary.expenses))}
                </div>
                {expensesDelta && expensesDeltaDir !== 'flat' && (
                  <div className="mt-1 flex items-center gap-1 font-body text-xs text-[color:var(--color-ink-muted)]">
                    <span
                      className="font-mono"
                      style={{
                        color: expensesDeltaDir === 'higher'
                          ? 'var(--color-accent)'
                          : 'var(--color-positive)',
                      }}
                    >
                      {expensesDelta.symbol}
                    </span>
                    <span>{expensesDelta.text} <span className="text-[color:var(--color-ink-faint)]">vs anterior</span></span>
                  </div>
                )}
              </div>
              {cashSummary.cardBills !== 0 && (
                <div>
                  <div className="font-body text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-accent)]">
                    faturas
                  </div>
                  <div className="mt-1 font-mono text-lg tabular-nums text-[color:var(--color-accent)]">
                    {formatBRL(Math.abs(cashSummary.cardBills))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma conta bancária conectada.
          </p>
        )}
      </div>

      {/* ═══ CARTÕES ═══ */}
      <div>
        <div className="eyebrow mb-6 uppercase">cartões</div>

        {/* Grand total + delta */}
        <div className="mb-6">
          <div className="font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]">
            {loading ? (
              <span className="inline-block h-12 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
            ) : (
              formatBRL(grandTotal)
            )}
          </div>

          {!loading && (() => {
            const d = formatDelta(grandDelta);
            const dir = grandDelta > 0.01 ? 'higher' : grandDelta < -0.01 ? 'lower' : 'flat';
            return (
              <div className="mt-2 flex items-center gap-2 font-body text-sm text-[color:var(--color-ink-muted)]">
                <span
                  className="font-mono"
                  style={{
                    color: dir === 'higher' ? 'var(--color-accent)'
                      : dir === 'lower' ? 'var(--color-positive)'
                      : 'var(--color-ink-faint)',
                  }}
                >
                  {d.symbol}
                </span>
                <span>
                  {d.text}{' '}
                  <span className="text-[color:var(--color-ink-faint)]">vs anterior</span>
                </span>
              </div>
            );
          })()}

          <p className="mt-2 font-body text-sm text-[color:var(--color-ink-muted)]">
            {configured.length} {configured.length === 1 ? 'fatura' : 'faturas'} com vencimento em {monthLabel(year, month)}
          </p>

          {/* Category breakdown */}
          {aggregatedCategories.length > 0 && (
            <CategoryBreakdown categories={aggregatedCategories} />
          )}
        </div>

        {/* Account cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-tour="cartoes">
          {configured.map(({ item, account, settings }, i) => {
            const offset = accountOffsets[i];
            const bq = breakdownQueries[i];
            const breakdown = bq?.data ?? null;

            return (
              <AccountCard
                key={account.id}
                item={item}
                account={account}
                settings={settings}
                breakdown={breakdown}
                loading={bq?.isLoading ?? false}
                onClick={() => {
                  if (offset !== null) {
                    onSelectAccount(item.id, account.id, offset);
                  }
                }}
              />
            );
          })}

          {unconfigured.map(({ item, account }) => (
            <UnconfiguredCard
              key={account.id}
              item={item}
              account={account}
              onClick={() => onSelectAccount(item.id, account.id, 0)}
            />
          ))}
        </div>
      </div>

      {/* ═══ COMPARTILHADOS ═══ */}
      {partnerCards.length > 0 && (
        <div className="mt-14">
          <div className="eyebrow mb-6 uppercase">compartilhados</div>
          <p className="mb-6 font-body text-sm text-[color:var(--color-ink-muted)]">
            Cartões de parceiros que dividem despesas com você. Valores são a
            sua parte (½ pela metade, dela pelo total).
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {partnerCards.map((card, i) => {
              const offset = partnerOffsets[i];
              const bq = partnerBreakdownQueries[i];
              return (
                <PartnerAccountCard
                  key={`${card.ownerUsername}:${card.accountId}`}
                  card={card}
                  breakdown={bq?.data ?? null}
                  loading={bq?.isLoading ?? false}
                  onClick={() => {
                    if (offset !== null) {
                      onSelectPartnerCard(card.ownerUsername, card.accountId, offset);
                    }
                  }}
                />
              );
            })}
          </div>

          {/* Aggregated category breakdown — ½ vs dela, separated */}
          {partnerCategorySummary.categories.length > 0 && (
            <div className="mt-8 grid gap-x-8 gap-y-8 md:grid-cols-2">
              <PartnerCategoryColumn
                label="½ metade"
                total={partnerCategorySummary.halfTotal}
                categories={partnerCategorySummary.categories
                  .filter((c) => c.halfTotal > 0)
                  .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.halfTotal }))
                  .sort((a, b) => b.total - a.total)}
                installments={partnerInstallments.half}
              />
              <PartnerCategoryColumn
                label="dela"
                total={partnerCategorySummary.theirsTotal}
                accent
                categories={partnerCategorySummary.categories
                  .filter((c) => c.theirsTotal > 0)
                  .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.theirsTotal }))
                  .sort((a, b) => b.total - a.total)}
                installments={partnerInstallments.theirs}
              />
            </div>
          )}
        </div>
      )}

      {/* ═══ DIVISÃO ═══ */}
      {aggregatedSplit && (
        <div data-tour="split">
          <SplitSection split={aggregatedSplit} variant="section" />
        </div>
      )}
    </motion.section>
  );
}
