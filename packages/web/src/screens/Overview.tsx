import { useState, useMemo } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { PluggyConnect } from 'react-pluggy-connect';
import { motion } from 'motion/react';
import {
  api,
  type Item,
  type Account,
  type AccountSettings,
  type BillBreakdown,
  type SplitSummary,
} from '../lib/api';
import { formatBRL, formatDateLong, formatDelta } from '../lib/format';
import { findOffsetForDueMonth, currentDueMonth } from '../lib/billWindow';

// ─── Month label ────────────────────────────────────────────────────

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function addMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = month - 1 + delta;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: y, month: m };
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
  onOpenCashFlow,
}: {
  items: Item[];
  /** Controlled month state — persisted in App so "voltar" restores it. */
  targetMonth: { year: number; month: number } | null;
  onMonthChange: (m: { year: number; month: number }) => void;
  onSelectAccount: (itemId: string, accountId: string, offset: number) => void;
  onOpenCashFlow: () => void;
}) {
  const today = useMemo(() => new Date(), []);

  // ── Gather all accounts + settings across all items ──

  const accountQueries = useQueries({
    queries: items.map((item) => ({
      queryKey: ['accounts', item.id],
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

  const settingsQueries = useQueries({
    queries: allAccounts.map(({ account }) => ({
      queryKey: ['accountSettings', account.id],
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
    if (configured.length === 0) return { year: today.getFullYear(), month: today.getMonth() + 1 };
    const s = configured[0].settings;
    return currentDueMonth({ closingDay: s.closing_day, dueDay: s.due_day }, today);
  }, [configured, today]);

  const year = controlledMonth?.year ?? defaultMonth.year;
  const month = controlledMonth?.month ?? defaultMonth.month;

  const isCurrentMonth =
    year === defaultMonth.year && month === defaultMonth.month;

  const nextMonth = addMonth(defaultMonth.year, defaultMonth.month, 1);
  const isNextMonth =
    year === nextMonth.year && month === nextMonth.month;
  const isFutureMonth =
    year > defaultMonth.year || (year === defaultMonth.year && month > defaultMonth.month);

  function navigateMonth(delta: number) {
    const next = addMonth(year, month, delta);
    onMonthChange(next);
  }

  // ── Cash flow summary for the target month ──

  const ms = `${year}-${month < 10 ? '0' : ''}${month}`;
  const prevM = addMonth(year, month, -1);
  const prevMs = `${prevM.year}-${prevM.month < 10 ? '0' : ''}${prevM.month}`;

  const cashflowQ = useQuery({
    queryKey: ['cashflow', ms],
    queryFn: () => api.getCashFlow(ms),
  });
  const prevCashflowQ = useQuery({
    queryKey: ['cashflow', prevMs],
    queryFn: () => api.getCashFlow(prevMs),
  });

  const cashSummary = useMemo(() => {
    const data = cashflowQ.data;
    if (!data) return null;

    const openingBalance = data.bankAccounts.reduce((s, ba) => s + (ba.openingBalance ?? 0), 0);
    let income = 0;
    let expenses = 0;
    let cardBills = 0;

    // Bill payment: either manually tagged or auto-detected from description.
    const isBillPayment = (e: typeof data.days[0]['entries'][0]) =>
      e.isBillPayment || /fatura/i.test(e.description) || /^INT\s/i.test(e.description);

    for (const day of data.days) {
      for (const e of day.entries) {
        if (day.isPast) {
          if (e.amount > 0) income += e.amount;
          else expenses += e.amount;
          if (e.type === 'bank_transaction' && e.amount < 0 && isBillPayment(e)) {
            cardBills += e.amount;
          }
        } else {
          // Projected: manual entries + credit card bills
          if (e.amount > 0) income += e.amount;
          else expenses += e.amount;
          if (e.type === 'credit_card_bill') {
            cardBills += e.amount;
          }
        }
      }
    }

    // Saldo: for current/past months use realized only; for future months use all entries.
    let balanceSum = 0;
    for (const day of data.days) {
      if (!isFutureMonth && !day.isPast) continue;
      for (const e of day.entries) balanceSum += e.amount;
    }
    const currentBalance = Math.round((openingBalance + balanceSum) * 100) / 100;

    return {
      openingBalance: Math.round(openingBalance * 100) / 100,
      currentBalance,
      income: Math.round(income * 100) / 100,
      expenses: Math.round((expenses - cardBills) * 100) / 100,
      cardBills: Math.round(cardBills * 100) / 100,
    };
  }, [cashflowQ.data, isFutureMonth]);

  const prevCashSummary = useMemo(() => {
    const data = prevCashflowQ.data;
    if (!data) return null;
    const isBill = (e: typeof data.days[0]['entries'][0]) =>
      e.isBillPayment || /fatura/i.test(e.description) || /^INT\s/i.test(e.description);
    let expenses = 0;
    let cardBills = 0;
    for (const day of data.days) {
      for (const e of day.entries) {
        if (e.amount < 0) {
          expenses += e.amount;
          if (
            (e.type === 'bank_transaction' && isBill(e)) ||
            e.type === 'credit_card_bill'
          ) {
            cardBills += e.amount;
          }
        }
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
        queryKey: ['billBreakdown', item.id, account.id, offset],
        queryFn: () => api.getBillBreakdown(item.id, account.id, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  // ── Split summaries across all configured accounts ──

  const splitQueries = useQueries({
    queries: configured.map(({ account }, i) => {
      const offset = accountOffsets[i];
      return {
        queryKey: ['splitSummary', account.id, offset],
        queryFn: () => api.getSplitSummary(account.id, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  const aggregatedSplit = useMemo(() => {
    let partnerOwes = 0;
    let totalCount = 0;
    let halfCount = 0;
    let halfTotal = 0;
    let halfOwes = 0;
    let theirsCount = 0;
    let theirsTotal = 0;
    let theirsOwes = 0;
    let mineCount = 0;
    let mineTotal = 0;
    const catMap = new Map<number, { id: number; name: string; color: string; halfTotal: number; theirsTotal: number; mineTotal: number }>();
    const installments: SplitSummary['installments'] = [];

    for (const q of splitQueries) {
      const s = q.data;
      if (!s) continue;
      partnerOwes += s.partnerOwes;
      totalCount += s.totalSplitTransactions;
      halfCount += s.breakdown.half.count;
      halfTotal += s.breakdown.half.total;
      halfOwes += s.breakdown.half.owes;
      theirsCount += s.breakdown.theirs.count;
      theirsTotal += s.breakdown.theirs.total;
      theirsOwes += s.breakdown.theirs.owes;
      mineCount += s.breakdown.mine.count;
      mineTotal += s.breakdown.mine.total;
      for (const cat of s.categories) {
        const existing = catMap.get(cat.id);
        if (existing) {
          existing.halfTotal += cat.halfTotal;
          existing.theirsTotal += cat.theirsTotal;
          existing.mineTotal += cat.mineTotal;
        } else {
          catMap.set(cat.id, {
            id: cat.id,
            name: cat.name,
            color: cat.color,
            halfTotal: cat.halfTotal,
            theirsTotal: cat.theirsTotal,
            mineTotal: cat.mineTotal,
          });
        }
      }
      installments.push(...s.installments);
    }

    if (totalCount === 0) return null;

    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      partnerOwes: round2(partnerOwes),
      totalCount,
      breakdown: {
        half: { count: halfCount, total: round2(halfTotal), owes: round2(halfOwes) },
        theirs: { count: theirsCount, total: round2(theirsTotal), owes: round2(theirsOwes) },
        mine: { count: mineCount, total: round2(mineTotal) },
      },
      categories: Array.from(catMap.values())
        .map((c) => ({
          ...c,
          halfTotal: round2(c.halfTotal),
          theirsTotal: round2(c.theirsTotal),
          mineTotal: round2(c.mineTotal),
          total: round2(c.halfTotal + c.theirsTotal + c.mineTotal),
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
      const allSlot = q.data.groups.find((g) => g.groupId === null);
      if (allSlot) {
        total += allSlot.total;
        delta += allSlot.delta;
      }
    });
    return { grandTotal: total, grandDelta: delta };
  }, [breakdownQueries]);

  // ── Aggregated category breakdown across all accounts ──

  const aggregatedCategories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string; total: number }>();
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      const allSlot = q.data.groups.find((g) => g.groupId === null);
      if (!allSlot) return;
      for (const cat of allSlot.categories) {
        const existing = map.get(cat.id);
        if (existing) {
          existing.total += cat.total;
        } else {
          map.set(cat.id, { ...cat });
        }
      }
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [breakdownQueries]);

  const loading =
    accountQueries.some((q) => q.isLoading) ||
    settingsQueries.some((q) => q.isLoading);

  // ── Render ──

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
          <div className="eyebrow flex items-center gap-3">
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
              disabled={isNextMonth}
              aria-label="próximo mês"
              className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:text-[color:var(--color-ink-faint)] disabled:opacity-40"
            >
              →
            </button>
          </div>
          <SyncAllButton items={items} />
        </div>
      </div>

      {/* ═══ CAIXA ═══ */}
      <div className="mb-14">
        <div className="eyebrow mb-6 uppercase">caixa</div>

        {cashflowQ.isLoading ? (
          <div className="h-24 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
        ) : cashSummary ? (
          <div>
            {/* Saldo headline */}
            <div className="font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

          <AddBankCard />
        </div>
      </div>

      {/* ═══ DIVISÃO ═══ */}
      {aggregatedSplit && (
        <SplitSection
          split={aggregatedSplit}
          year={year}
          month={month}
        />
      )}
    </motion.section>
  );
}

// ─── Sync all button ────────────────────────────────────────────────

function SyncAllButton({ items }: { items: Item[] }) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await Promise.all(items.map((item) => api.syncTransactions(item.id)));
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['accountSettings'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch (err) {
      console.error('[SyncAll] failed:', err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={syncing}
      className="shrink-0 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
    >
      {syncing ? 'sincronizando…' : 'sincronizar ↻'}
    </button>
  );
}

// ─── Category breakdown ─────────────────────────────────────────────

const CATEGORY_COLLAPSE_LIMIT = 6;

function CategoryBreakdown({
  categories,
}: {
  categories: Array<{ id: number; name: string; color: string; total: number }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, CATEGORY_COLLAPSE_LIMIT);
  const hiddenCount = categories.length - CATEGORY_COLLAPSE_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div className="mt-8">
      <ul className="space-y-2.5">
        {visible.map((cat) => (
          <li key={cat.id}>
            <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
              <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                {formatBRL(cat.total)}
              </span>
            </div>
            <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
              <div
                className="h-full"
                style={{
                  background: cat.color,
                  width: `${Math.round((Math.max(0, cat.total) / denominator) * 100)}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 font-body text-[11px] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
        </button>
      )}
    </div>
  );
}

// ─── Account card ───────────────────────────────────────────────────

function AccountCard({
  item,
  account,
  settings,
  breakdown,
  loading,
  onClick,
}: {
  item: Item;
  account: Account;
  settings: AccountSettings;
  breakdown: BillBreakdown | null;
  loading: boolean;
  onClick: () => void;
}) {
  const queryClient = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: () => api.deleteItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
    },
  });

  const allSlot = breakdown?.groups.find((g) => g.groupId === null);
  const total = allSlot?.total ?? 0;
  const displayName =
    settings.display_name ?? account.name ?? item.connector_name ?? 'Conta';

  return (
    <div className="group relative flex flex-col items-start border border-[color:var(--color-paper-rule)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-ink-muted)]">
      {/* Delete button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Remover "${displayName}" e todos os seus dados?`)) {
            deleteMut.mutate();
          }
        }}
        disabled={deleteMut.isPending}
        className="absolute top-3 right-3 font-body text-xs text-[color:var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[color:var(--color-accent)] group-hover:opacity-100 disabled:opacity-50"
        aria-label={`Remover ${displayName}`}
      >
        remover
      </button>

      {/* Main clickable area */}
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-start text-left"
      >
        <span className="eyebrow mb-3 text-[color:var(--color-ink-muted)] transition-colors group-hover:text-[color:var(--color-accent)]">
          {displayName}
        </span>

        {loading ? (
          <span className="inline-block h-10 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
        ) : (
          <span className="font-display text-[40px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
            {formatBRL(total)}
          </span>
        )}

        {allSlot && (() => {
          const d = formatDelta(allSlot.delta);
          const dir = allSlot.delta > 0.01 ? 'higher' : allSlot.delta < -0.01 ? 'lower' : 'flat';
          return (
            <span className="mt-2 flex items-center gap-1.5 font-body text-xs text-[color:var(--color-ink-muted)]">
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
              <span>{d.text} <span className="text-[color:var(--color-ink-faint)]">vs ant.</span></span>
            </span>
          );
        })()}

        {breakdown && (
          <span className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-body text-xs text-[color:var(--color-ink-muted)]">
            <span>
              fecha{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.closingDate)}
              </span>
            </span>
            <span>
              vence{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.dueDate)}
              </span>
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

// ─── Unconfigured account card ──────────────────────────────────────

function UnconfiguredCard({
  item,
  account,
  onClick,
}: {
  item: Item;
  account: Account;
  onClick: () => void;
}) {
  const displayName = account.name ?? item.connector_name ?? 'Conta';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start border border-dashed border-[color:var(--color-accent-soft)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-accent)]"
    >
      <span className="eyebrow mb-3 text-[color:var(--color-accent)]">
        {displayName}
      </span>
      <span className="font-body text-sm text-[color:var(--color-ink-muted)]">
        Configurar dia de fechamento e vencimento para incluir na visão geral.
      </span>
      <span className="mt-3 eyebrow text-[color:var(--color-accent)] transition-colors group-hover:text-[color:var(--color-ink)]">
        Configurar →
      </span>
    </button>
  );
}

// ─── Split section ─────────────────────────────────────────────────

const SPLIT_CAT_LIMIT = 6;
const SPLIT_INST_LIMIT = 4;

function SplitSection({
  split,
  year,
  month,
}: {
  split: {
    partnerOwes: number;
    totalCount: number;
    breakdown: {
      half: { count: number; total: number; owes: number };
      theirs: { count: number; total: number; owes: number };
      mine: { count: number; total: number };
    };
    categories: Array<{ id: number; name: string; color: string; halfTotal: number; theirsTotal: number; mineTotal: number; total: number }>;
    installments: Array<{
      id: string;
      date: string;
      description: string | null;
      amount: number;
      splitType: 'half' | 'theirs' | 'mine';
      installmentNumber: number;
      totalInstallments: number;
    }>;
  };
  year: number;
  month: number;
}) {
  // Separate categories into three independent lists
  const makeCatList = (key: 'halfTotal' | 'theirsTotal' | 'mineTotal') =>
    split.categories
      .filter((c) => c[key] > 0)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c[key] }))
      .sort((a, b) => b.total - a.total);
  const halfCategories = makeCatList('halfTotal');
  const theirsCategories = makeCatList('theirsTotal');
  const mineCategories = makeCatList('mineTotal');

  // Separate installments into three lists
  const halfInstallments = split.installments.filter((i) => i.splitType === 'half');
  const theirsInstallments = split.installments.filter((i) => i.splitType === 'theirs');
  const mineInstallments = split.installments.filter((i) => i.splitType === 'mine');

  return (
    <div className="mt-14">
      <div className="eyebrow mb-6 uppercase">divisão</div>

      {/* Total headline */}
      <div className="mb-6">
        <div className="font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]">
          {formatBRL(split.partnerOwes)}
        </div>
        <p className="mt-2 font-body text-sm text-[color:var(--color-ink-muted)]">
          {split.totalCount} {split.totalCount === 1 ? 'transação dividida' : 'transações divididas'}
        </p>

        {/* Columns: ½, dela, meu — only those with data */}
        {(() => {
          const columns: React.ReactNode[] = [];
          if (split.breakdown.half.count > 0) {
            columns.push(
              <OverviewSplitColumn
                key="half"
                label="½"
                total={formatBRL(split.breakdown.half.owes)}
                subtitle={`${split.breakdown.half.count}x — total ${formatBRL(split.breakdown.half.total)}`}
                categories={halfCategories}
                installments={halfInstallments}
              />,
            );
          }
          if (split.breakdown.theirs.count > 0) {
            columns.push(
              <OverviewSplitColumn
                key="theirs"
                label="dela"
                total={formatBRL(split.breakdown.theirs.owes)}
                subtitle={`${split.breakdown.theirs.count}x — total ${formatBRL(split.breakdown.theirs.total)}`}
                categories={theirsCategories}
                installments={theirsInstallments}
                accent
              />,
            );
          }
          if (split.breakdown.mine.count > 0) {
            columns.push(
              <OverviewSplitColumn
                key="mine"
                label="meu"
                total={formatBRL(split.breakdown.mine.total)}
                subtitle={`${split.breakdown.mine.count}x`}
                categories={mineCategories}
                installments={mineInstallments}
              />,
            );
          }
          const cols = columns.length === 1 ? 'grid-cols-1' : columns.length === 2 ? 'grid-cols-2' : 'grid-cols-3';
          return (
            <div className={`mt-8 grid ${cols} gap-8`}>
              {columns}
            </div>
          );
        })()}

      </div>
    </div>
  );
}

function OverviewSplitColumn({
  label,
  total,
  subtitle,
  categories,
  installments,
  accent,
}: {
  label: string;
  total: string;
  subtitle: string;
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  installments: Array<{
    id: string;
    description: string | null;
    amount: number;
    installmentNumber: number;
    totalInstallments: number;
  }>;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <div
        className="mt-1 font-display text-[32px] leading-none tracking-[-0.02em]"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink)' }}
      >
        {total}
      </div>
      <div className="mt-1 font-body text-[10px] text-[color:var(--color-ink-faint)]">
        {subtitle}
      </div>
      {categories.length > 0 && (
        <div className="mt-5">
          <OverviewSplitCategoryList categories={categories} accent={accent} />
        </div>
      )}
      {installments.length > 0 && (
        <div className="mt-5 border-t border-[color:var(--color-paper-rule)] pt-3">
          <OverviewSplitInstallmentList installments={installments} accent={accent} />
        </div>
      )}
    </div>
  );
}

function OverviewSplitCategoryList({
  categories,
  accent,
}: {
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, SPLIT_CAT_LIMIT);
  const hiddenCount = categories.length - SPLIT_CAT_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div>
      <ul className="space-y-2.5">
        {visible.map((cat) => (
          <li key={cat.id}>
            <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
              <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
              <span
                className="shrink-0 font-mono tabular-nums"
                style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
              >
                {formatBRL(cat.total)}
              </span>
            </div>
            <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
              <div
                className="h-full"
                style={{
                  background: cat.color,
                  width: `${Math.round((Math.max(0, cat.total) / denominator) * 100)}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 font-body text-[11px] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
        </button>
      )}
    </div>
  );
}

function OverviewSplitInstallmentList({
  installments,
  accent,
}: {
  installments: Array<{
    id: string;
    description: string | null;
    amount: number;
    installmentNumber: number;
    totalInstallments: number;
  }>;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? installments : installments.slice(0, SPLIT_INST_LIMIT);
  const hiddenCount = installments.length - SPLIT_INST_LIMIT;

  return (
    <div>
      <ul className="space-y-2">
        {visible.map((inst) => (
          <li
            key={inst.id}
            className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 font-body text-[12px]"
          >
            <span className="truncate text-[color:var(--color-ink-soft)]">
              {stripInstallmentSuffix(inst.description)}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
              {inst.installmentNumber}/{inst.totalInstallments}
            </span>
            <span
              className="font-mono tabular-nums"
              style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
            >
              {formatBRL(inst.amount)}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 font-body text-[11px] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
        </button>
      )}
    </div>
  );
}

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(description: string | null): string {
  if (!description) return '—';
  return description.replace(INSTALLMENT_SUFFIX, '').trim() || '—';
}

// ─── Add bank card ──────────────────────────────────────────────────

function AddBankCard() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'syncing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const tokenMut = useMutation({
    mutationFn: api.connectToken,
    onSuccess: ({ accessToken }) => setToken(accessToken),
  });

  async function handleConnect(itemId: string) {
    setToken(null);
    setErrorMsg(null);
    try {
      setStatus('saving');
      await api.saveItem(itemId);

      setStatus('syncing');
      await api.syncTransactions(itemId);

      // Refresh everything so the new account appears.
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['accountSettings'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
      setStatus('idle');
    } catch (err) {
      console.error('[AddBank] failed:', err);
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Erro desconhecido');
      // Still refresh — the item may have been saved even if sync failed.
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          tokenMut.mutate();
        }}
        disabled={tokenMut.isPending || status === 'saving' || status === 'syncing'}
        className="flex flex-col items-center justify-center gap-2 border border-dashed border-[color:var(--color-paper-rule)] px-5 py-8 text-center transition-colors hover:border-[color:var(--color-ink-muted)] disabled:opacity-50"
      >
        <span className="font-display text-2xl text-[color:var(--color-ink-faint)]">+</span>
        <span className="eyebrow text-[color:var(--color-ink-muted)]">
          {tokenMut.isPending
            ? 'Abrindo…'
            : status === 'saving'
              ? 'Salvando…'
              : status === 'syncing'
                ? 'Sincronizando…'
                : 'Adicionar banco'}
        </span>
        {(status === 'error' || tokenMut.isError) && (
          <span className="mt-1 font-body text-xs text-[color:var(--color-accent)]">
            {errorMsg ?? 'Falha ao abrir o widget. Tente novamente.'}
          </span>
        )}
      </button>

      {token && (
        <PluggyConnect
          connectToken={token}
          includeSandbox={true}
          language="pt"
          theme="light"
          onSuccess={({ item }) => handleConnect(item.id)}
          onClose={() => setToken(null)}
          onError={() => setToken(null)}
        />
      )}
    </>
  );
}
