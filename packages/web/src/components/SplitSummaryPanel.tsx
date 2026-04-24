import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatBRL } from '../lib/format';

const SPLIT_CAT_LIMIT = 4;
const SPLIT_INST_LIMIT = 4;

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
}: {
  accountId: string;
  offset: number;
}) {
  const summaryQ = useQuery({
    queryKey: ['splitSummary', accountId, offset],
    queryFn: () => api.getSplitSummary(accountId, offset),
  });

  const summary = summaryQ.data;
  if (!summary || summary.totalSplitTransactions === 0) return null;

  // Separate categories into three independent lists
  const makeCatList = (key: 'halfTotal' | 'theirsTotal' | 'mineTotal') =>
    summary.categories
      .filter((c) => c[key] > 0)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c[key] }))
      .sort((a, b) => b.total - a.total);
  const halfCategories = makeCatList('halfTotal');
  const theirsCategories = makeCatList('theirsTotal');
  const mineCategories = makeCatList('mineTotal');

  // Separate installments into three lists
  const halfInstallments = summary.installments.filter((i) => i.splitType === 'half');
  const theirsInstallments = summary.installments.filter((i) => i.splitType === 'theirs');
  const mineInstallments = summary.installments.filter((i) => i.splitType === 'mine');

  return (
    <section className="rule-top mt-10 pt-6 text-left">
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

      {/* Columns: ½, dela, meu — only those with data */}
      {(() => {
        const columns: React.ReactNode[] = [];
        if (summary.breakdown.half.count > 0) {
          columns.push(
            <SplitColumn
              key="half"
              label="½"
              total={formatBRL(summary.breakdown.half.owes)}
              subtitle={`${summary.breakdown.half.count}x — total ${formatBRL(summary.breakdown.half.total)}`}
              categories={halfCategories}
              installments={halfInstallments}
            />,
          );
        }
        if (summary.breakdown.theirs.count > 0) {
          columns.push(
            <SplitColumn
              key="theirs"
              label="dela"
              total={formatBRL(summary.breakdown.theirs.owes)}
              subtitle={`${summary.breakdown.theirs.count}x — total ${formatBRL(summary.breakdown.theirs.total)}`}
              categories={theirsCategories}
              installments={theirsInstallments}
              accent
            />,
          );
        }
        if (summary.breakdown.mine.count > 0) {
          columns.push(
            <SplitColumn
              key="mine"
              label="meu"
              total={formatBRL(summary.breakdown.mine.total)}
              subtitle={`${summary.breakdown.mine.count}x`}
              categories={mineCategories}
              installments={mineInstallments}
            />,
          );
        }
        const cols = columns.length === 1 ? 'grid-cols-1' : columns.length === 2 ? 'grid-cols-2' : 'grid-cols-3';
        return (
          <div className={`mt-6 grid ${cols} gap-6`}>
            {columns}
          </div>
        );
      })()}

    </section>
  );
}

function SplitColumn({
  label,
  total,
  subtitle,
  categories,
  installments,
  accent,
}: {
  label: string;
  total: string;
  subtitle: string;
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  installments: Array<{
    id: string;
    description: string | null;
    amount: number;
    installmentNumber: number;
    totalInstallments: number;
  }>;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <div
        className="mt-1 font-display text-[28px] leading-none tracking-[-0.02em]"
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink)' }}
      >
        {total}
      </div>
      <div className="mt-1 font-body text-[10px] text-[color:var(--color-ink-faint)]">
        {subtitle}
      </div>
      {categories.length > 0 && (
        <div className="mt-4">
          <SplitCategoryList categories={categories} accent={accent} />
        </div>
      )}
      {installments.length > 0 && (
        <div className="mt-4 border-t border-[color:var(--color-paper-rule)] pt-3">
          <SplitInstallmentList installments={installments} accent={accent} />
        </div>
      )}
    </div>
  );
}

function SplitCategoryList({
  categories,
  accent,
}: {
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, SPLIT_CAT_LIMIT);
  const hiddenCount = categories.length - SPLIT_CAT_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div>
      <ul className="space-y-2.5">
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

function SplitInstallmentList({
  installments,
  accent,
}: {
  installments: Array<{
    id: string;
    description: string | null;
    amount: number;
    installmentNumber: number;
    totalInstallments: number;
  }>;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? installments : installments.slice(0, SPLIT_INST_LIMIT);
  const hiddenCount = installments.length - SPLIT_INST_LIMIT;

  return (
    <div>
      <ul className="space-y-2">
        {visible.map((inst) => (
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
            <span
              className="font-mono tabular-nums"
              style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
            >
              {formatBRL(inst.amount)}
            </span>
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

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(description: string | null): string {
  if (!description) return '—';
  return description.replace(INSTALLMENT_SUFFIX, '').trim() || '—';
}
