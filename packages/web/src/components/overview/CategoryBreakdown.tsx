import { useState } from 'react';
import { formatBRL, variationLabel } from '../../lib/format';

// ─── Category breakdown ─────────────────────────────────────────────

const CATEGORY_COLLAPSE_LIMIT = 6;

export function CategoryBreakdown({
  categories,
}: {
  categories: Array<{ id: number; name: string; color: string; total: number; previousTotal: number }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, CATEGORY_COLLAPSE_LIMIT);
  const hiddenCount = categories.length - CATEGORY_COLLAPSE_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div className="mt-8">
      <ul className="space-y-2.5">
        {visible.map((cat) => (
          <li key={cat.id}>
            <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
              <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span className="font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                  {formatBRL(cat.total)}
                </span>
                {variationLabel(cat.total, cat.previousTotal) && (
                  <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
                    ({variationLabel(cat.total, cat.previousTotal)})
                  </span>
                )}
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
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 font-body text-[11px] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
        </button>
      )}
    </div>
  );
}
