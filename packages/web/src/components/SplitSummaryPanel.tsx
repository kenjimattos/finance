import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type SplitSummary } from '../lib/api';
import { formatBRL } from '../lib/format';

const SPLIT_CAT_LIMIT = 4;
const INSTALLMENT_COLLAPSE_LIMIT = 4;

/**
 * A card that mirrors the BillCard visual pattern but shows the split
 * (partner-owes) values: total, category breakdown with proportional
 * bars, and installments. Renders inside the BillCardGrid row.
 *
 * Returns null when there are no split transactions in the cycle,
 * so the grid simply doesn't show the card.
 */
export function SplitSummaryCard({
  accountId,
  offset,
  displayName,
  dueDate,
}: {
  accountId: string;
  offset: number;
  displayName: string | null;
  dueDate: string;
}) {
  const [copied, setCopied] = useState(false);
  const [installmentsExpanded, setInstallmentsExpanded] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['splitSummary', accountId, offset],
    queryFn: () => api.getSplitSummary(accountId, offset),
  });

  const summary = summaryQ.data;
  if (!summary || summary.totalSplitTransactions === 0) return null;

  const dueDateLabel = formatDueDateLabel(dueDate);

  // Separate categories into two independent lists
  const halfCategories = summary.categories
    .filter((c) => c.halfTotal > 0)
    .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.halfTotal }))
    .sort((a, b) => b.total - a.total);
  const theirsCategories = summary.categories
    .filter((c) => c.theirsTotal > 0)
    .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.theirsTotal }))
    .sort((a, b) => b.total - a.total);
  const hasCategories = halfCategories.length > 0 || theirsCategories.length > 0;

  const visibleInstallments = installmentsExpanded
    ? summary.installments
    : summary.installments.slice(0, INSTALLMENT_COLLAPSE_LIMIT);
  const hiddenInstallmentCount =
    summary.installments.length - visibleInstallments.length;

  function copyToClipboard(s: SplitSummary) {
    const lines: string[] = [];
    lines.push(`Fatura ${dueDateLabel} — ${displayName ?? 'Cartão'}`);
    lines.push('');
    for (const tx of s.transactions) {
      const desc = (tx.description ?? '—').padEnd(30);
      const amt = formatBRL(tx.amount);
      const label = tx.splitType === 'half' ? '50/50' : 'dela';
      const owes = formatBRL(tx.owes);
      lines.push(
        `${formatDay(tx.date)}  ${desc}  ${amt}  (${label} → ${owes})`,
      );
    }
    lines.push('');
    lines.push(`Total que deve: ${formatBRL(s.partnerOwes)}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="relative flex flex-col border border-[color:var(--color-paper-rule)] p-5 text-left">
      {/* Eyebrow: "Divisão" with accent dot */}
      <div className="mb-3 flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--color-accent)' }}
          aria-hidden="true"
        />
        <span className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-accent)]">
          Divisão
        </span>
        <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
          ({summary.totalSplitTransactions})
        </span>
      </div>

      {/* The total — partner owes */}
      <div className="font-display text-[44px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
        {formatBRL(summary.partnerOwes)}
      </div>

      {/* Half / Theirs badges */}
      <div className="mt-3 flex items-center gap-4 font-body text-xs text-[color:var(--color-ink-muted)]">
        {summary.breakdown.half.count > 0 && (
          <span>
            <span className="font-mono font-semibold text-[color:var(--color-ink)]">
              ½
            </span>{' '}
            {summary.breakdown.half.count}x ={' '}
            {formatBRL(summary.breakdown.half.owes)}
          </span>
        )}
        {summary.breakdown.theirs.count > 0 && (
          <span>
            <span className="font-mono font-semibold text-[color:var(--color-accent)]">
              dela
            </span>{' '}
            {summary.breakdown.theirs.count}x ={' '}
            {formatBRL(summary.breakdown.theirs.owes)}
          </span>
        )}
      </div>

      {/* Category breakdown — two independent lists side by side */}
      {hasCategories && (
        <div className="mt-6 grid grid-cols-2 gap-4">
          {halfCategories.length > 0 && (
            <SplitCategoryList label="½" categories={halfCategories} />
          )}
          {theirsCategories.length > 0 && (
            <SplitCategoryList label="dela" categories={theirsCategories} accent />
          )}
        </div>
      )}

      {/* Installments — parceladas that are split */}
      {summary.installments.length > 0 && (
        <div className="mt-6 border-t border-[color:var(--color-paper-rule)] pt-4">
          <SubsectionLabel>Parceladas</SubsectionLabel>
          <ul className="mt-2 space-y-2">
            {visibleInstallments.map((inst) => (
              <li
                key={inst.id}
                className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 font-body text-[12px]"
              >
                <span className="truncate text-[color:var(--color-ink-soft)]">
                  {stripInstallmentSuffix(inst.description)}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
                  {inst.installmentNumber}/{inst.totalInstallments}
                </span>
                <span className="font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                  {formatBRL(inst.amount)}
                </span>
              </li>
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

      {/* Copy to clipboard */}
      <div className="mt-6 border-t border-[color:var(--color-paper-rule)] pt-4">
        <button
          type="button"
          onClick={() => copyToClipboard(summary)}
          className="font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)]"
        >
          {copied ? 'copiado!' : 'copiar para splitwise'}
        </button>
      </div>
    </div>
  );
}

function SplitCategoryList({
  label,
  categories,
  accent,
}: {
  label: string;
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, SPLIT_CAT_LIMIT);
  const hiddenCount = categories.length - SPLIT_CAT_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div>
      <SubsectionLabel>{label}</SubsectionLabel>
      <ul className="mt-2 space-y-2.5">
        {visible.map((cat) => (
          <li key={cat.id}>
            <div className="flex items-baseline justify-between gap-2 font-body text-[12px]">
              <span className="truncate text-[color:var(--color-ink-soft)]">
                {cat.name}
              </span>
              <span
                className="shrink-0 font-mono tabular-nums"
                style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
              >
                {formatBRL(cat.total)}
              </span>
            </div>
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
      {hiddenCount > 0 && (
        <ExpandToggle
          expanded={expanded}
          hiddenCount={hiddenCount}
          onToggle={() => setExpanded((e) => !e)}
        />
      )}
    </div>
  );
}

function SubsectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
      {children}
    </div>
  );
}

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
      onClick={onToggle}
      className="mt-3 font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
    >
      {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
    </button>
  );
}

function formatDay(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function formatDueDateLabel(dueDate: string): string {
  const months = [
    'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
    'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
  ];
  const m = parseInt(dueDate.slice(5, 7), 10);
  const y = dueDate.slice(0, 4);
  return `${months[m - 1]}/${y}`;
}

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(description: string | null): string {
  if (!description) return '—';
  return description.replace(INSTALLMENT_SUFFIX, '').trim() || '—';
}
