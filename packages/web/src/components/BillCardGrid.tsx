import { useState } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type BillGroupBreakdown,
  type BillBreakdown,
  type BillInstallmentBreakdown,
  type CardGroupFilter,
} from '../lib/api';
import { formatBRL, formatDateLong, formatDateShort, formatDelta } from '../lib/format';

const CATEGORY_COLLAPSE_LIMIT = 4;
const INSTALLMENT_COLLAPSE_LIMIT = 4;

/**
 * Layout philosophy (as of this iteration):
 *
 *   - The "Todos" entry returned by the backend is NOT rendered as a card
 *     in the grid. Its total becomes the big editorial number at the top;
 *     its category breakdown is not shown at all because the per-card
 *     breakdowns below tell the story per cartão.
 *   - The grid shows one card per user-defined card group, and nothing
 *     else. If the user has no groups yet, a small hint points to
 *     "gerenciar cartões" so the tela doesn't look broken.
 *   - Clicking a card toggles it as the active filter. Clicking it again
 *     (or clicking another card that was active) returns to "Todos".
 *     There is no separate "Todos" card to click — the absence of
 *     selection IS the "Todos" state.
 */

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
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  // The "all" slot comes first from the backend. Extract it for the headline
  // and render only real groups in the grid.
  const allSlot =
    breakdown.groups.find((g) => g.groupId == null) ?? null;
  const groupSlots = breakdown.groups.filter((g) => g.groupId != null);

  const allDelta = allSlot ? formatDelta(allSlot.delta) : null;
  const allDeltaDirection = !allSlot
    ? 'flat'
    : allSlot.delta > 0.01
      ? 'higher'
      : allSlot.delta < -0.01
        ? 'lower'
        : 'flat';

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Editorial header: eyebrow + giant total + dates on one side,
          action links on the other. */}
      <div className="mb-10 flex items-start justify-between gap-6">
        <div>
          <div className="eyebrow">
            {breakdown.displayName ?? 'Fatura em aberto'}
          </div>
          <div className="mt-3 font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
            {formatBRL(allSlot?.total ?? 0)}
          </div>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-body text-sm text-[color:var(--color-ink-muted)]">
            <span>
              fecha em{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.closingDate)}
              </span>
            </span>
            <span>
              vence em{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.dueDate)}
              </span>
            </span>
            {allDelta && (
              <span className="flex items-center gap-2">
                <span
                  className="font-mono"
                  style={{
                    color:
                      allDeltaDirection === 'higher'
                        ? 'var(--color-accent)'
                        : allDeltaDirection === 'lower'
                          ? 'var(--color-positive)'
                          : 'var(--color-ink-faint)',
                  }}
                >
                  {allDelta.symbol}
                </span>
                <span>
                  {allDelta.text}{' '}
                  <span className="text-[color:var(--color-ink-faint)]">vs anterior</span>
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-5 pt-2">
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

      {groupSlots.length === 0 ? (
        <p className="rule-top py-6 font-body text-sm italic text-[color:var(--color-ink-faint)]">
          Crie grupos de cartão em{' '}
          <button
            type="button"
            onClick={onManageCards}
            className="underline decoration-[color:var(--color-accent)] underline-offset-4 hover:text-[color:var(--color-accent)]"
          >
            gerenciar cartões
          </button>{' '}
          para ver o breakdown por cartão.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {groupSlots.map((g) => {
            const filter: CardGroupFilter = g.groupId as number;
            const isActive = selected === g.groupId;
            return (
              <BillCard
                key={g.groupId}
                group={g}
                active={isActive}
                onClick={() => onSelect(isActive ? 'all' : filter)}
              />
            );
          })}
        </div>
      )}
    </motion.section>
  );
}

function BillCard({
  group,
  active,
  onClick,
}: {
  group: BillGroupBreakdown;
  active: boolean;
  onClick: () => void;
}) {
  const delta = formatDelta(group.delta);
  const deltaDirection =
    group.delta > 0.01 ? 'higher' : group.delta < -0.01 ? 'lower' : 'flat';

  // Bars represent each category's share of THIS card's total, not its
  // proportion against the biggest category. "Alimentação = 40%" means
  // "40% of everything you spent with this card went to food", which is
  // the story the user actually wants to read off the card.
  //
  // Note we sum the category totals (rather than reusing group.total) to
  // avoid a subtle off-by-one: group.total includes CREDIT reversals,
  // while group.categories only lists POSITIVE categorized spend. Using
  // the category sum keeps the bars adding up to 100% on the card.
  const categoriesSum = group.categories.reduce((acc, c) => acc + Math.max(0, c.total), 0);
  const denominator = categoriesSum > 0 ? categoriesSum : 1;

  const [categoriesExpanded, setCategoriesExpanded] = useState(false);
  const [installmentsExpanded, setInstallmentsExpanded] = useState(false);

  const visibleCategories = categoriesExpanded
    ? group.categories
    : group.categories.slice(0, CATEGORY_COLLAPSE_LIMIT);
  const hiddenCategoryCount = group.categories.length - visibleCategories.length;

  const visibleInstallments = installmentsExpanded
    ? group.installments
    : group.installments.slice(0, INSTALLMENT_COLLAPSE_LIMIT);
  const hiddenInstallmentCount =
    group.installments.length - visibleInstallments.length;

  // The whole card is clickable (toggles the active filter), but it has
  // interactive children (expand/collapse buttons) so it can't be a real
  // <button> — nesting buttons is invalid HTML. Use a role="button" div
  // with keyboard support instead.
  function handleCardActivate(
    e: React.KeyboardEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>,
  ) {
    if ('key' in e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
    }
    onClick();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardActivate}
      onKeyDown={handleCardActivate}
      className="group relative flex cursor-pointer flex-col border p-5 text-left transition-[background,border-color] hover:bg-[color:var(--color-paper-tint)] focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)]"
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

      {/* The total — Fraunces, subordinate to the big headline above */}
      <div className="font-display text-[44px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
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
        <div className="mt-6">
          <SubsectionLabel>Categorias</SubsectionLabel>
          <ul className="mt-2 space-y-2.5">
            {visibleCategories.map((cat) => (
              <li key={cat.id}>
                <div className="flex items-baseline justify-between gap-3 font-body text-[12px]">
                  <span className="truncate text-[color:var(--color-ink-soft)]">
                    {cat.name}
                  </span>
                  <span className="font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                    {formatBRL(cat.total)}
                  </span>
                </div>
                {/* The thin proportional bar — 2px high, category color.
                    Width is this category's share of the card's total spend. */}
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
          {(hiddenCategoryCount > 0 || categoriesExpanded) && (
            <ExpandToggle
              expanded={categoriesExpanded}
              hiddenCount={hiddenCategoryCount}
              onToggle={() => setCategoriesExpanded((e) => !e)}
            />
          )}
        </div>
      )}

      {group.categories.length === 0 && (
        <p className="mt-6 font-body text-xs italic text-[color:var(--color-ink-faint)]">
          Nenhuma transação categorizada ainda neste grupo.
        </p>
      )}

      {/* Installment sub-section — pre-committed spending landing in this bill */}
      {group.installments.length > 0 && (
        <div className="mt-6 border-t border-[color:var(--color-paper-rule)] pt-4">
          <SubsectionLabel>Parceladas</SubsectionLabel>
          <ul className="mt-2 space-y-2">
            {visibleInstallments.map((inst) => (
              <InstallmentRow key={inst.id} installment={inst} />
            ))}
          </ul>
          {(hiddenInstallmentCount > 0 || installmentsExpanded) && (
            <ExpandToggle
              expanded={installmentsExpanded}
              hiddenCount={hiddenInstallmentCount}
              onToggle={() => setInstallmentsExpanded((e) => !e)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Small caps header used to label a sub-section inside a card.
 */
function SubsectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
      {children}
    </div>
  );
}

/**
 * Toggle for expand/collapse of a sub-section list.
 *
 * stopPropagation on click is essential: the whole card is a clickable
 * region that toggles the active filter, so without it, clicking
 * "+ N mais" would also toggle the filter.
 */
function ExpandToggle({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="mt-3 font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
    >
      {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
    </button>
  );
}

/**
 * One row of the installment sub-section.
 *
 * Shows: cleaned description (slice off the trailing " PARCxx/yy" suffix
 * Pluggy embeds), the installment counter in mono, and the amount.
 * The counter slice is a display-time local cleanup — we deliberately do
 * NOT mutate t.description in the shared transaction shape, because the
 * user asked to keep that untouched for now.
 */
function InstallmentRow({
  installment,
}: {
  installment: BillInstallmentBreakdown;
}) {
  const cleanDescription = stripInstallmentSuffix(installment.description);
  return (
    <li className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 font-body text-[12px]">
      <span className="truncate text-[color:var(--color-ink-soft)]">
        {cleanDescription}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
        {installment.installmentNumber}/{installment.totalInstallments}
      </span>
      <span className="font-mono tabular-nums text-[color:var(--color-ink-muted)]">
        {formatBRL(installment.amount)}
      </span>
    </li>
  );
}

/**
 * Remove the Pluggy " PARCxx/yy" suffix from a transaction description.
 * Pluggy embeds the installment counter directly in the description
 * string (e.g. "MERCADO*MERCADPARC05/10"), which is redundant with the
 * structured installmentNumber/totalInstallments we already render.
 *
 * Matches both the space-separated and glued-on variants defensively.
 */
function stripInstallmentSuffix(description: string | null): string {
  if (!description) return '—';
  return description.replace(/\s*PARC\d{1,2}\/\d{1,2}\s*$/i, '').trim() || '—';
}
