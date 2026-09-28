import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatBRL, formatDelta } from '../../lib/format';
import { keys } from '../../lib/queryKeys';
import { nonBillExpenses, summarizeCashMonth } from '../../lib/overviewAggregates';

/** Caixa: the month's saldo, entradas, saídas (vs the previous month) and faturas. */
export function CashSection({
  month,
  prevMonth,
  isCurrentMonth,
  isFutureMonth,
  onOpenCashFlow,
}: {
  /** YYYY-MM */
  month: string;
  prevMonth: string;
  isCurrentMonth: boolean;
  isFutureMonth: boolean;
  onOpenCashFlow: () => void;
}) {
  const cashflowQ = useQuery({
    queryKey: keys.cashflow.month(month),
    queryFn: () => api.getCashFlow(month),
  });
  const prevCashflowQ = useQuery({
    queryKey: keys.cashflow.month(prevMonth),
    queryFn: () => api.getCashFlow(prevMonth),
  });

  const cashSummary = cashflowQ.data ? summarizeCashMonth(cashflowQ.data, isFutureMonth) : null;
  const prevExpenses = prevCashflowQ.data ? nonBillExpenses(prevCashflowQ.data) : null;

  const expensesDelta = cashSummary && prevExpenses !== null
    ? formatDelta(cashSummary.expenses - prevExpenses)
    : null;
  const expensesDeltaDir = cashSummary && prevExpenses !== null
    ? (cashSummary.expenses - prevExpenses) < -0.01 ? 'higher'
      : (cashSummary.expenses - prevExpenses) > 0.01 ? 'lower'
      : 'flat'
    : 'flat';

  return (
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
  );
}
