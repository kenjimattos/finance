import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type SplitSummary } from '../lib/api';
import { formatBRL } from '../lib/format';

/**
 * Collapsible panel showing the split summary for the current bill cycle.
 * Displays how much the partner owes and a "copy to clipboard" button
 * that generates Splitwise-friendly text.
 */
export function SplitSummaryPanel({
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
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['splitSummary', accountId, offset],
    queryFn: () => api.getSplitSummary(accountId, offset),
  });

  const summary = summaryQ.data;
  if (!summary || summary.totalSplitTransactions === 0) return null;

  const dueDateLabel = formatDueDateLabel(dueDate);

  function copyToClipboard(s: SplitSummary) {
    const lines: string[] = [];
    lines.push(`Fatura ${dueDateLabel} — ${displayName ?? 'Cartão'}`);
    lines.push('');
    for (const tx of s.transactions) {
      const desc = (tx.description ?? '—').padEnd(30);
      const amt = formatBRL(tx.amount);
      const label = tx.splitType === 'half' ? '50/50' : 'dela';
      const owes = formatBRL(tx.owes);
      lines.push(`${formatDay(tx.date)}  ${desc}  ${amt}  (${label} → ${owes})`);
    }
    lines.push('');
    lines.push(`Total que deve: ${formatBRL(s.partnerOwes)}`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="mt-10 border-t border-[color:var(--color-paper-rule)] pt-6">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-baseline justify-between"
      >
        <div className="flex items-baseline gap-3">
          <h3 className="font-display text-lg tracking-tight text-[color:var(--color-ink)]">
            Divisão
          </h3>
          <span className="font-mono text-xs text-[color:var(--color-ink-faint)]">
            ({summary.totalSplitTransactions})
          </span>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="font-mono text-base font-semibold tabular-nums text-[color:var(--color-accent)]">
            {formatBRL(summary.partnerOwes)}
          </span>
          <span className="font-body text-xs text-[color:var(--color-ink-muted)]">
            {expanded ? 'ocultar' : 'ver detalhes'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-4">
          {/* Breakdown badges */}
          <div className="mb-4 flex gap-6">
            {summary.breakdown.half.count > 0 && (
              <div className="font-body text-xs text-[color:var(--color-ink-muted)]">
                <span className="font-mono font-semibold text-[color:var(--color-ink)]">½</span>
                {' '}{summary.breakdown.half.count}x = {formatBRL(summary.breakdown.half.total)}
                {' '}→ deve {formatBRL(summary.breakdown.half.owes)}
              </div>
            )}
            {summary.breakdown.theirs.count > 0 && (
              <div className="font-body text-xs text-[color:var(--color-ink-muted)]">
                <span className="font-mono font-semibold text-[color:var(--color-accent)]">dela</span>
                {' '}{summary.breakdown.theirs.count}x = {formatBRL(summary.breakdown.theirs.total)}
                {' '}→ deve {formatBRL(summary.breakdown.theirs.owes)}
              </div>
            )}
          </div>

          {/* Transaction list */}
          <div className="divide-y divide-[color:var(--color-paper-rule)]">
            {summary.transactions.map((tx) => (
              <div
                key={tx.id}
                className="grid grid-cols-[48px_1fr_auto_auto] items-baseline gap-4 py-2"
              >
                <span className="font-mono text-xs text-[color:var(--color-ink-muted)]">
                  {formatDay(tx.date)}
                </span>
                <span className="truncate font-body text-sm text-[color:var(--color-ink)]">
                  {tx.description ?? '—'}
                </span>
                <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
                  {tx.splitType === 'half' ? '½' : '→dela'}
                </span>
                <span className="font-mono text-sm tabular-nums text-[color:var(--color-accent)]">
                  {formatBRL(tx.owes)}
                </span>
              </div>
            ))}
          </div>

          {/* Copy button */}
          <button
            type="button"
            onClick={() => copyToClipboard(summary)}
            className="mt-4 font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)]"
          >
            {copied ? 'copiado!' : 'copiar para splitwise'}
          </button>
        </div>
      )}
    </section>
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
