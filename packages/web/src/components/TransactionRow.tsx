import type { Category, Transaction } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';
import { CategoryTrigger } from './CategoryPicker';

/**
 * One printed-row-of-the-broadsheet per transaction.
 *
 * Layout:
 *   [checkbox] [date] [description + category]               [amount]
 *
 * - Description is in the body font (Inter), compact
 * - Amount is mono, right-aligned, tabular-nums for clean columns
 * - Category lives inline underneath the description as a small pill
 * - `assignedBy === 'learned'` is rendered with a subtle "auto" hint
 */
export function TransactionRow({
  tx,
  categories,
  selected,
  onToggleSelected,
  onAssign,
  onClear,
}: {
  tx: Transaction;
  categories: Category[];
  selected: boolean;
  onToggleSelected: () => void;
  onAssign: (categoryId: number) => void;
  onClear: () => void;
}) {
  // Sign convention (from Meu Pluggy for credit card accounts):
  //   DEBIT  = purchase     → amount positive  → outflow (ink)
  //   CREDIT = refund/credit → amount negative  → inflow  (olive)
  // We key on tx.type instead of the sign so the display is explicit and
  // doesn't break if a connector ever sends zero-amount entries.
  const isOutflow = tx.type === 'DEBIT';
  const amountDisplay = formatBRL(Math.abs(tx.amount));

  return (
    <div
      className="row-reveal group grid grid-cols-[24px_56px_1fr_auto] items-center gap-4 py-3 transition-colors"
      style={{
        background: selected ? 'var(--color-paper-tint)' : 'transparent',
      }}
    >
      <label className="flex cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          className="h-4 w-4 cursor-pointer accent-[color:var(--color-accent)]"
          aria-label={`Selecionar ${tx.description ?? 'transação'}`}
        />
      </label>

      <div className="font-mono text-xs uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {formatDateShort(tx.date)}
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="truncate font-body text-[15px] text-[color:var(--color-ink)]">
            {tx.description ?? '—'}
          </span>
          {tx.installmentNumber && tx.totalInstallments && (
            <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
              {tx.installmentNumber}/{tx.totalInstallments}
            </span>
          )}
          {tx.cardLast4 && (
            <span className="font-mono text-[10px] tracking-wider text-[color:var(--color-ink-faint)]">
              ····{tx.cardLast4}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <CategoryTrigger
            label={tx.userCategory?.name ?? 'sem categoria'}
            color={tx.userCategory?.color}
            categories={categories}
            onPick={onAssign}
            onClear={tx.userCategory ? onClear : undefined}
          />
          {tx.userCategory?.assignedBy === 'learned' && (
            <span className="font-body text-[10px] italic text-[color:var(--color-ink-faint)]">
              auto
            </span>
          )}
        </div>
      </div>

      <div
        className="font-mono text-[15px] tabular-nums"
        style={{
          color: isOutflow
            ? 'var(--color-ink)'
            : 'var(--color-positive)',
        }}
      >
        {isOutflow ? '−' : '+'}
        {amountDisplay}
      </div>
    </div>
  );
}
