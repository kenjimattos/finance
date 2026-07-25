import type { Category, Transaction } from '../lib/api';
import { formatBRL, formatCardLabel, formatDateShort } from '../lib/format';
import { CategoryTrigger } from './CategoryPicker';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';

/**
 * One printed-row-of-the-broadsheet per transaction.
 *
 * Layout:
 *   [checkbox] [date] [description + category]         [amount] [⋯]
 *
 * - Description is in the body font (Inter), compact
 * - Amount is mono, right-aligned, tabular-nums for clean columns
 * - Category lives inline underneath the description as a small pill
 * - `assignedBy === 'learned'` is rendered with a subtle "auto" hint
 * - The trailing "⋯" opens a menu with rare actions — currently just
 *   "mover para outra fatura", but the container is ready to grow
 */
export function TransactionRow({
  tx,
  categories,
  selected,
  onToggleSelected,
  onAssign,
  onClear,
  onShift,
  onSplit,
  onToggleHidden,
  onEditManual,
  onDeleteManual,
}: {
  tx: Transaction;
  categories: Category[];
  selected: boolean;
  onToggleSelected: () => void;
  onAssign: (categoryId: number) => void;
  onClear: () => void;
  onShift: (shift: -1 | 0 | 1) => void;
  onSplit: (splitType: 'half' | 'theirs' | null) => void;
  onToggleHidden: () => void;
  onEditManual?: () => void;
  onDeleteManual?: () => void;
}) {
  // Sign convention (from Meu Pluggy for credit card accounts):
  //   DEBIT  = purchase     → amount positive  → outflow (ink)
  //   CREDIT = refund/credit → amount negative  → inflow  (olive)
  // We key on tx.type instead of the sign so the display is explicit and
  // doesn't break if a connector ever sends zero-amount entries.
  const isOutflow = tx.type === 'DEBIT';
  const amountDisplay = formatBRL(Math.abs(tx.amount));

  // Additive shift: buttons increment/decrement the current shift value,
  // capped at ±1. This means clicking "anterior" on a shift=+1 transaction
  // naturally restores it to 0 instead of jumping to -1.
  const currentShift = tx.billShift ?? 0;
  const isManual = tx.source === 'manual';
  const actions: RowAction[] = [
    {
      label: currentShift === -1 ? '→ Restaurar para esta fatura' : '→ Próxima fatura',
      onClick: () => onShift((currentShift + 1) as -1 | 0 | 1),
      disabled: currentShift >= 1,
    },
    {
      label: currentShift === 1 ? '← Restaurar para esta fatura' : '← Fatura anterior',
      onClick: () => onShift((currentShift - 1) as -1 | 0 | 1),
      disabled: currentShift <= -1,
    },
  ];
  // Split actions
  if (tx.split !== 'half') {
    actions.push({
      label: '½ Dividir 50/50',
      onClick: () => onSplit('half'),
    });
  }
  if (tx.split !== 'theirs') {
    actions.push({
      label: '→ Pago por ela',
      onClick: () => onSplit('theirs'),
    });
  }
  if (tx.split) {
    actions.push({
      label: '× Remover divisão',
      onClick: () => onSplit(null),
    });
  }

  // Hide-from-bill: excludes the row from every total/breakdown/split
  // computation without deleting it (deleting a pluggy row would just
  // re-insert on the next sync). Restoring brings it back untouched.
  actions.push({
    label: tx.hidden ? '👁 Restaurar na fatura' : '⌀ Ocultar da fatura',
    onClick: onToggleHidden,
  });

  if (isManual && onEditManual) {
    actions.push({
      label: 'Editar lançamento',
      onClick: onEditManual,
    });
  }
  if (isManual && onDeleteManual) {
    actions.push({
      label: 'Excluir lançamento',
      onClick: onDeleteManual,
      tone: 'danger',
    });
  }

  function SideInfos({classname}:{classname?: String}){
    return(
      <div className={`${classname}`}>
          <div className={`flex items-baseline gap-3`}>
            {tx.cardLast4 && (
              <span className="font-mono text-[10px] tracking-wider text-[color:var(--color-ink-faint)] hidden md:inline">
                {formatCardLabel(tx.cardLast4)}
              </span>
            )}
            {isManual && (
              <span className="font-body text-[10px] italic text-[color:var(--color-accent)]">
                manual
              </span>
            )}
            {tx.hidden && (
              <span className="font-body text-[10px] italic text-[color:var(--color-ink-faint)]">
                oculta
              </span>
            )}
            {tx.split && (
              <span className="font-mono text-[10px] font-semibold text-[color:var(--color-accent)]">
                {tx.split === 'half' ? '½' : '→dela'}
              </span>
            )}
          </div>
        </div>
    )
  }
  

  return (
    <div
      className="row-reveal group grid grid-cols-[24px_24px_1fr_auto_24px] md:grid-cols-[24px_56px_1fr_auto_24px] items-center gap-4 py-3 transition-colors"
      style={{
        background: selected ? 'var(--color-paper-tint)' : 'transparent',
        opacity: tx.hidden ? 0.45 : 1,
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
        
        <div className="flex flex-row items-center gap-3">
          <span className="line-clamp-1 font-body text-[15px] text-[color:var(--color-ink)]">
            {tx.description ?? '—'}
          </span>
              {tx.installmentNumber && tx.totalInstallments && (
            <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
              {tx.installmentNumber}/{tx.totalInstallments}
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
            <span className="font-body text-[10px] italic text-[color:var(--color-ink-faint)] hidden md:inline">
              auto
            </span>
          )}
          <SideInfos classname={"hidden md:inline"} />
        </div>
      </div>

      <div className="flex flex-col items-center">
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
        <SideInfos classname={"inline md:hidden"} />
      </div>

      <RowActionsMenu actions={actions} />
    </div>
  );
}
