import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type BillGroupBreakdown,
  type BillBreakdown,
  type CardGroupFilter,
} from '../lib/api';
import { formatBRL, formatDateLong, formatDelta } from '../lib/format';

/**
 * The new dashboard header: an editorial grid of cards — one per card group
 * plus an "all" card at the front — each showing the group's total, delta,
 * and a sorted category breakdown.
 *
 * Clicking a card toggles it as the active filter for the transaction list
 * below. The selected card is outlined with the accent color. Clicking it
 * again returns to "Todos".
 *
 * The layout is a plain CSS grid (3/2/1 columns by breakpoint). The user
 * has said they will have ≤3 cards for the foreseeable future; we do not
 * do carousels, horizontal scroll, or any fancy overflow handling.
 */
export function BillCardGrid({
  breakdown,
  itemId,
  selected,
  onSelect,
  onManageCards,
}: {
  breakdown: BillBreakdown;
  itemId: string;
  selected: CardGroupFilter;
  onSelect: (filter: CardGroupFilter) => void;
  onManageCards: () => void;
}) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.syncTransactions(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['currentBill', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Small editorial header above the grid */}
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <div className="eyebrow">
            {breakdown.displayName ?? 'Fatura em aberto'}
          </div>
          <p className="mt-1 font-body text-sm leading-relaxed text-[color:var(--color-ink-muted)]">
            fecha em{' '}
            <span className="text-[color:var(--color-ink-soft)]">
              {formatDateLong(breakdown.closingDate)}
            </span>{' '}
            · vence em{' '}
            <span className="text-[color:var(--color-ink-soft)]">
              {formatDateLong(breakdown.dueDate)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={onManageCards}
            className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
          >
            gerenciar cartões
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {breakdown.groups.map((g) => {
          const filter: CardGroupFilter =
            g.groupId == null ? 'all' : g.groupId;
          const isActive =
            (selected === 'all' && g.groupId == null) ||
            selected === g.groupId;
          return (
            <BillCard
              key={g.groupId ?? 'all'}
              group={g}
              isAll={g.groupId == null}
              active={isActive}
              onClick={() => onSelect(isActive ? 'all' : filter)}
            />
          );
        })}
      </div>
    </motion.section>
  );
}

function BillCard({
  group,
  isAll,
  active,
  onClick,
}: {
  group: BillGroupBreakdown;
  isAll: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const delta = formatDelta(group.delta);
  const deltaDirection =
    group.delta > 0.01 ? 'higher' : group.delta < -0.01 ? 'lower' : 'flat';

  // The max category total for the current card, used to scale the proportional
  // bars so the biggest category fills the bar width.
  const maxCategoryTotal = Math.max(
    1, // guard against divide-by-zero if list is empty
    ...group.categories.map((c) => c.total),
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col border p-5 text-left transition-[background,border-color] hover:bg-[color:var(--color-paper-tint)]"
      style={{
        borderColor: active ? 'var(--color-accent)' : 'var(--color-paper-rule)',
        background: active ? 'var(--color-paper-tint)' : 'transparent',
      }}
    >
      {/* Eyebrow: group name + color dot */}
      <div className="mb-3 flex items-center gap-2">
        {group.color && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: group.color }}
            aria-hidden="true"
          />
        )}
        <span
          className="font-body text-[11px] uppercase tracking-[0.14em]"
          style={{
            color: active
              ? 'var(--color-accent)'
              : 'var(--color-ink-muted)',
          }}
        >
          {group.name}
        </span>
      </div>

      {/* The total — Fraunces, bigger on the "all" card */}
      <div
        className="font-display leading-none tracking-[-0.02em] text-[color:var(--color-ink)]"
        style={{ fontSize: isAll ? '52px' : '44px' }}
      >
        {formatBRL(group.total)}
      </div>

      {/* Delta */}
      <div className="mt-3 flex items-center gap-2 font-body text-xs text-[color:var(--color-ink-muted)]">
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
      </div>

      {/* Category breakdown — thin bars, small type */}
      {group.categories.length > 0 && (
        <ul className="mt-6 space-y-2.5">
          {group.categories.map((cat) => (
            <li key={cat.id}>
              <div className="flex items-baseline justify-between gap-3 font-body text-[12px]">
                <span className="truncate text-[color:var(--color-ink-soft)]">
                  {cat.name}
                </span>
                <span className="font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                  {formatBRL(cat.total)}
                </span>
              </div>
              {/* The thin proportional bar — 2px high, category color, fades out */}
              <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
                <div
                  className="h-full"
                  style={{
                    background: cat.color,
                    width: `${Math.round((cat.total / maxCategoryTotal) * 100)}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {group.categories.length === 0 && (
        <p className="mt-6 font-body text-xs italic text-[color:var(--color-ink-faint)]">
          Nenhuma transação categorizada ainda neste grupo.
        </p>
      )}
    </button>
  );
}
