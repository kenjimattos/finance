import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type BillBreakdown } from '../lib/api';
import {
  formatBRL,
  formatDateLong,
  formatDelta,
  formatMonthYear,
} from '../lib/format';

/**
 * Editorial bill headline: offset navigation, giant total, delta vs previous
 * cycle, closing/due dates. Actions (regras, gerenciar cartões, sincronizar)
 * live to the right of the headline.
 */
export function BillHeader({
  breakdown,
  itemId,
  offset,
  onChangeOffset,
  onManageRules,
}: {
  breakdown: BillBreakdown;
  itemId: string;
  /** 0 = currently open bill, -N = N cycles in the past. */
  offset: number;
  onChangeOffset: (nextOffset: number) => void;
  onManageRules: () => void;
}) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.syncTransactions(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
      queryClient.invalidateQueries({ queryKey: ['accounts', itemId] });
    },
  });

  const delta = formatDelta(breakdown.delta);
  const deltaDirection =
    breakdown.delta > 0.01
      ? 'higher'
      : breakdown.delta < -0.01
        ? 'lower'
        : 'flat';

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      <div className="mb-10 flex items-start justify-between gap-6">
        <div>
          <div className="eyebrow flex items-center gap-3">
            <button
              type="button"
              onClick={() => onChangeOffset(offset - 1)}
              aria-label="fatura anterior"
              className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none"
            >
              ←
            </button>
            <span>
              {offset === 0
                ? (breakdown.displayName ?? 'Fatura em aberto')
                : breakdown.displayName
                  ? `${breakdown.displayName} · ${formatMonthYear(breakdown.closingDate)}`
                  : `Fatura ${formatMonthYear(breakdown.closingDate)}`}
            </span>
            <button
              type="button"
              onClick={() => onChangeOffset(offset + 1)}
              disabled={offset >= 0}
              aria-label="próxima fatura"
              className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:text-[color:var(--color-ink-faint)] disabled:opacity-40"
            >
              →
            </button>
          </div>
          <div className="mt-3 font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
            {formatBRL(breakdown.total)}
          </div>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-body text-sm text-[color:var(--color-ink-muted)]">
            <span>
              {offset === 0 ? 'fecha em' : 'fechou em'}{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.closingDate)}
              </span>
            </span>
            <span>
              {offset === 0 ? 'vence em' : 'venceu em'}{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.dueDate)}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span
                className="font-mono"
                style={{
                  color:
                    deltaDirection === 'higher'
                      ? 'var(--color-accent)'
                      : deltaDirection === 'lower'
                        ? 'var(--color-positive)'
                        : 'var(--color-ink-faint)',
                }}
              >
                {delta.symbol}
              </span>
              <span>
                {delta.text}{' '}
                <span className="text-[color:var(--color-ink-faint)]">vs anterior</span>
              </span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-5 pt-2">
          <button
            type="button"
            onClick={onManageRules}
            className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
          >
            regras
          </button>
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
          >
            {sync.isPending ? 'sincronizando…' : 'sincronizar ↻'}
          </button>
        </div>
      </div>

    </motion.section>
  );
}
