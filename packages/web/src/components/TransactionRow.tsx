import type { Category, Transaction } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';
import { CategoryTrigger } from './CategoryPicker';

/**
 * One printed-row-of-the-broadsheet per transaction.
 *
 * Layout:
 *   [checkbox] [date] [description + category + shift]         [amount]
 *
 * - Description is in the body font (Inter), compact
 * - Amount is mono, right-aligned, tabular-nums for clean columns
 * - Category lives inline underneath the description as a small pill
 * - `assignedBy === 'learned'` is rendered with a subtle "auto" hint
 * - Next to the category, a native <select> lets the user push the
 *   transaction into the neighboring bill cycle when the purchase
 *   date doesn't match when the charge actually lands
 */
export function TransactionRow({
  tx,
  categories,
  selected,
  onToggleSelected,
  onAssign,
  onClear,
  onShift,
}: {
  tx: Transaction;
  categories: Category[];
  selected: boolean;
  onToggleSelected: () => void;
  onAssign: (categoryId: number) => void;
  onClear: () => void;
  onShift: (shift: -1 | 0 | 1) => void;
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
          <BillShiftSelect value={tx.billShift} onChange={onShift} />
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

/**
 * Native <select> styled as a tiny pill. Three states:
 *    null  → "neste ciclo"  (default; no override)
 *    +1    → "→ próxima"    (pushed forward)
 *    -1    → "← anterior"   (pulled backward)
 *
 * When the value is non-null, the pill gets the accent color so a
 * shifted row visually stands out from a plain one.
 */
function BillShiftSelect({
  value,
  onChange,
}: {
  value: -1 | 1 | null;
  onChange: (shift: -1 | 0 | 1) => void;
}) {
  const isShifted = value != null;
  return (
    <select
      value={value ?? 0}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (n === -1 || n === 0 || n === 1) onChange(n);
      }}
      onClick={(e) => e.stopPropagation()}
      className="cursor-pointer border px-2 py-0.5 font-body text-[10px] uppercase tracking-[0.1em] transition-colors focus:outline-none"
      style={{
        borderColor: isShifted ? 'var(--color-accent)' : 'var(--color-paper-rule)',
        background: isShifted
          ? 'var(--color-paper-tint)'
          : 'var(--color-paper-tint)',
        color: isShifted
          ? 'var(--color-accent)'
          : 'var(--color-ink-faint)',
      }}
      title="Mover este lançamento para outro ciclo"
    >
      <option value={0}>neste ciclo</option>
      <option value={1}>→ próxima fatura</option>
      <option value={-1}>← fatura anterior</option>
    </select>
  );
}
