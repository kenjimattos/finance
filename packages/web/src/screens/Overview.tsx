import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import type { Item } from '../lib/apiTypes';
import { ThemeToggle } from '../components/ThemeToggle';
import { useIsDemo } from '../lib/useIsDemo';
import { keys } from '../lib/queryKeys';
import { addMonth, monthStr } from '../lib/month';
import { hasRealEntries } from '../lib/overviewAggregates';
import { useCreditAccounts } from '../lib/useCreditAccounts';
import { SyncAllButton } from '../components/overview/SyncAllButton';
import { ManageBankButton } from '../components/overview/ManageBankButton';
import { CashSection } from '../components/overview/CashSection';
import { CardsSection } from '../components/overview/CardsSection';
import { PartnerSection } from '../components/overview/PartnerSection';
import { SplitAggregateSection } from '../components/overview/SplitAggregateSection';

// ─── Month label ────────────────────────────────────────────────────

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// ─── Overview ───────────────────────────────────────────────────────

/**
 * The month at a glance: Caixa, Cartões, Compartilhados and Divisão. Owns the
 * month navigation; each section fetches and sums its own data for `ms`.
 */
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
  const { allAccounts, configured, unconfigured, loading } = useCreditAccounts(items);

  // ── Target month (defaults to the current calendar month) ──

  const defaultMonth = useMemo(
    () => ({ year: today.getFullYear(), month: today.getMonth() + 1 }),
    [today],
  );

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

  const ms = monthStr(year, month);
  const prevM = addMonth(year, month, -1);
  const nextM = addMonth(year, month, 1);
  const nextMs = monthStr(nextM.year, nextM.month);

  // Probe the NEXT month so the "→" arrow enables only when there's
  // something real to navigate to. Card activity is NOT part of this
  // decision — Dashboard gates bill navigation on its own.
  const nextCashflowQ = useQuery({
    queryKey: keys.cashflow.month(nextMs),
    queryFn: () => api.getCashFlow(nextMs),
  });
  const hasEntriesInNextMonth = hasRealEntries(nextCashflowQ.data);

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
            {!isDemo && <ManageBankButton items={items} accounts={allAccounts} />}
            <ThemeToggle />
          </div>
        </div>
      </div>

      <CashSection
        month={ms}
        prevMonth={monthStr(prevM.year, prevM.month)}
        isCurrentMonth={isCurrentMonth}
        isFutureMonth={isFutureMonth}
        onOpenCashFlow={onOpenCashFlow}
      />

      <CardsSection
        month={ms}
        monthLabel={monthLabel(year, month)}
        configured={configured}
        unconfigured={unconfigured}
        loading={loading}
        onSelectAccount={onSelectAccount}
      />

      <PartnerSection month={ms} onSelectPartnerCard={onSelectPartnerCard} />

      <SplitAggregateSection month={ms} configured={configured} />
    </motion.section>
  );
}
