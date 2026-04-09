import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type OpenBill } from '../lib/api';
import { formatBRL, formatDateLong, formatDelta } from '../lib/format';

/**
 * The editorial bill card. Mirrors a magazine feature opener:
 *  - tiny eyebrow with the date frame
 *  - giant serif number (the total owed)
 *  - a delta line in small caps
 *  - a single discreet action (sync)
 *
 * Intentionally calm — this is the first thing the user sees, it sets
 * the tone of the whole screen. No cards, no gradients, no shadows.
 */
export function BillHeader({
  bill,
  itemId,
}: {
  bill: OpenBill;
  itemId: string;
}) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.syncTransactions(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['currentBill', itemId] });
    },
  });

  const delta = formatDelta(bill.delta);
  const deltaDirection =
    bill.delta > 0.01 ? 'higher' : bill.delta < -0.01 ? 'lower' : 'flat';

  return (
    <motion.header
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="eyebrow">
          {bill.displayName ?? 'Fatura em aberto'}
        </div>
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
        >
          {sync.isPending ? 'sincronizando…' : 'sincronizar ↻'}
        </button>
      </div>

      <p className="font-body text-sm leading-relaxed text-[color:var(--color-ink-muted)]">
        fecha em{' '}
        <span className="text-[color:var(--color-ink-soft)]">
          {formatDateLong(bill.closingDate)}
        </span>{' '}
        · vence em{' '}
        <span className="text-[color:var(--color-ink-soft)]">
          {formatDateLong(bill.dueDate)}
        </span>
      </p>

      <motion.div
        key={bill.total}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mt-6 flex items-baseline gap-4"
      >
        <span className="font-display text-[96px] leading-none tracking-[-0.035em] text-[color:var(--color-ink)] md:text-[136px]">
          {formatBRL(bill.total)}
        </span>
      </motion.div>

      <div className="mt-4 flex items-center gap-3 font-body text-sm text-[color:var(--color-ink-muted)]">
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
          aria-label={deltaDirection === 'higher' ? 'mais alto' : 'mais baixo'}
        >
          {delta.symbol}
        </span>
        <span>
          {delta.text} <span className="text-[color:var(--color-ink-faint)]">vs fatura anterior</span>
        </span>
      </div>
    </motion.header>
  );
}
