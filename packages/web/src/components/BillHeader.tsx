import { useState } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import type { BillBreakdown } from '../lib/apiTypes';
import {
  formatBRL,
  formatDateLong,
  formatDelta,
  formatMonthYear,
} from '../lib/format';
import { useIsDemo } from '../lib/useIsDemo';
import { keys } from '../lib/queryKeys';
import { useBillMutations } from '../lib/useBillMutations';
import { useToast } from './Toast';

/**
 * Editorial bill headline: offset navigation, giant total, delta vs previous
 * cycle, closing/due dates. Actions (regras, gerenciar cartões, sincronizar)
 * live to the right of the headline.
 *
 * The closing and due dates are editable for this bill only: issuers move a
 * single closing for a weekend or holiday, and the account's default days
 * keep applying to every other cycle.
 */
export function BillHeader({
  breakdown,
  itemId,
  accountId,
  offset,
  onChangeOffset,
  onManageRules,
}: {
  breakdown: BillBreakdown;
  itemId: string;
  accountId: string;
  /** 0 = currently open bill, -N = N cycles in the past. */
  offset: number;
  onChangeOffset: (nextOffset: number) => void;
  onManageRules: () => void;
}) {
  const queryClient = useQueryClient();
  const isDemo = useIsDemo();
  const toast = useToast();
  const { setCycleOverride } = useBillMutations({ itemId, accountId });

  // Each editor sends its own date and keeps the other one as it is: the
  // other date's override if there is one, the default (null) otherwise.
  const keptClosing = breakdown.closingOverridden ? breakdown.closingDate : null;
  const keptDue = breakdown.dueOverridden ? breakdown.dueDate : null;
  function saveDates(dates: { closingDate: string | null; dueDate: string | null }) {
    setCycleOverride.mutate(
      { cycleMonth: breakdown.cycleMonth, ...dates },
      {
        onSuccess: (r) => {
          const parts = [
            `Esta fatura fecha em ${formatDateLong(r.closingDate)} e vence em ${formatDateLong(r.dueDate)}.`,
          ];
          if (r.realignedShifts > 0) {
            parts.push(
              r.realignedShifts === 1
                ? '1 lançamento deslocado foi ajustado para continuar na mesma fatura.'
                : `${r.realignedShifts} lançamentos deslocados foram ajustados para continuar na mesma fatura.`,
            );
          }
          toast.show({ message: parts.join(' ') });
          // Closing the open bill early (or reopening it) changes which cycle
          // each offset points at; stay on the bill that was edited.
          if (r.offset !== offset) onChangeOffset(r.offset);
        },
        onError: (err) => toast.show({ message: apiErrorMessage(err) }),
      },
    );
  }
  const sync = useMutation({
    mutationFn: () => api.syncTransactions(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.transactions.all });
      queryClient.invalidateQueries({ queryKey: keys.billBreakdown.all });
      queryClient.invalidateQueries({ queryKey: keys.accounts.ofItem(itemId) });
    },
  });

  const delta = formatDelta(breakdown.delta);
  const deltaDirection =
    breakdown.delta > 0.01
      ? 'higher'
      : breakdown.delta < -0.01
        ? 'lower'
        : 'flat';

  // Now that future offsets are allowed (when there are lançamentos), base the
  // "em aberto / passada / futura" copy on the actual closing date vs today,
  // not on `offset === 0`.
  const today = new Date().toISOString().slice(0, 10);
  const isClosed = breakdown.closingDate < today;
  const isOpen = breakdown.periodStart <= today && today <= breakdown.closingDate;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      <div className="mb-10 flex-col items-start justify-between gap-6">
          <div className='flex justify-between w-full'>
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
                {isOpen
                  ? (breakdown.displayName ?? 'Fatura em aberto')
                  : breakdown.displayName
                    ? `${breakdown.displayName} · ${formatMonthYear(breakdown.closingDate)}`
                    : `Fatura ${formatMonthYear(breakdown.closingDate)}`}
              </span>
              <button
                type="button"
                onClick={() => onChangeOffset(offset + 1)}
                disabled={!breakdown.hasNextBillTransactions}
                aria-label="próxima fatura"
                className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:text-[color:var(--color-ink-faint)] disabled:opacity-40"
              >
                →
              </button>
            </div>
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={onManageRules}
                className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] hidden md:inline-flex"
              >
                regras
              </button>
              {!isDemo && (
                <button
                  type="button"
                  onClick={() => sync.mutate()}
                  disabled={sync.isPending}
                  className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
                >
                  {sync.isPending ? 'sincronizando…' : 'sincronizar ↻'}
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
            {formatBRL(breakdown.total)}
          </div>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-body text-sm text-[color:var(--color-ink-muted)]">
            <EditableBillDate
              label={isClosed ? 'fechou em' : 'fecha em'}
              value={breakdown.closingDate}
              overridden={breakdown.closingOverridden}
              pending={setCycleOverride.isPending}
              onSave={(d) => saveDates({ closingDate: d, dueDate: keptDue })}
              onReset={() => saveDates({ closingDate: null, dueDate: keptDue })}
            />
            <EditableBillDate
              label={breakdown.dueDate < today ? 'venceu em' : 'vence em'}
              value={breakdown.dueDate}
              overridden={breakdown.dueOverridden}
              pending={setCycleOverride.isPending}
              onSave={(d) => saveDates({ closingDate: keptClosing, dueDate: d })}
              onReset={() => saveDates({ closingDate: keptClosing, dueDate: null })}
            />
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
    </motion.section>
  );
}

/** The API answers errors with `{ error, message? }`; show its message when there is one. */
function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.message) as { message?: string };
      if (body.message) return body.message;
    } catch {
      // not JSON — fall through
    }
  }
  return 'Não foi possível salvar a data.';
}

const ACTION_CLASS =
  'font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:opacity-50';

/**
 * "fecha em 16 de junho" with the date as a button: clicking it opens a date
 * input for this bill only. A dot marks a date that differs from the
 * account's default, and "usar padrão" removes it.
 */
function EditableBillDate({
  label,
  value,
  overridden,
  pending,
  onSave,
  onReset,
}: {
  label: string;
  value: string;
  overridden: boolean;
  pending: boolean;
  onSave: (date: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const close = () => setDraft(null);

  if (draft === null) {
    return (
      <span>
        {label}{' '}
        <button
          type="button"
          onClick={() => setDraft(value)}
          title="ajustar só nesta fatura"
          className="text-[color:var(--color-ink-soft)] underline decoration-[color:var(--color-ink-faint)] decoration-dotted underline-offset-4 transition-colors hover:text-[color:var(--color-accent)] hover:decoration-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none"
        >
          {formatDateLong(value)}
        </button>
        {overridden && (
          <span
            title="data ajustada só nesta fatura"
            aria-label="ajustada só nesta fatura"
            className="ml-1 text-[color:var(--color-accent)]"
          >
            •
          </span>
        )}
      </span>
    );
  }

  const save = () => {
    if (draft && draft !== value) onSave(draft);
    close();
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{label}</span>
      <input
        type="date"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') close();
        }}
        aria-label={label}
        className="border border-[color:var(--color-ink)]/20 bg-transparent px-2 py-0.5 font-mono text-xs text-[color:var(--color-ink)]"
      />
      <button type="button" onClick={save} disabled={pending || !draft} className={ACTION_CLASS}>
        salvar
      </button>
      {overridden && (
        <button
          type="button"
          onClick={() => {
            onReset();
            close();
          }}
          disabled={pending}
          className={ACTION_CLASS}
        >
          usar padrão
        </button>
      )}
      <button type="button" onClick={close} className={ACTION_CLASS}>
        cancelar
      </button>
    </span>
  );
}
