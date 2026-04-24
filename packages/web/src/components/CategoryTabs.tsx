import type { BillCategoryBreakdown } from '../lib/api';

/**
 * Horizontal row of category tabs above the transaction list.
 *
 * Feeds on the category breakdown of whichever card is currently selected:
 * only categories that actually have spending in the current bill+group
 * are shown, so the row stays relevant instead of listing every category
 * the user has ever created.
 *
 * "Todas" is always first and means "no filter".
 *
 * Filtering is done on the frontend (Array.filter in TransactionInbox) —
 * we intentionally did not add yet another cardCategoryId parameter to
 * /transactions because the categories shown here are derived from data
 * already in the frontend.
 */
export type CategoryTabFilter = 'all' | number;

export function CategoryTabs({
  categories,
  selected,
  onSelect,
}: {
  categories: BillCategoryBreakdown[];
  selected: CategoryTabFilter;
  onSelect: (filter: CategoryTabFilter) => void;
}) {
  if (categories.length === 0) return null;

  return (
    <section className="rule-top mt-10 pt-6">
      <div className="mb-3 flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--color-accent)' }}
          aria-hidden="true"
        />
        <span className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-accent)]">
          Categorias
        </span>
        <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
          ({categories.length})
        </span>
      </div>
      <nav className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <Tab
          label="Todas"
          active={selected === 'all'}
          onClick={() => onSelect('all')}
        />
        {categories.map((c) => (
          <Tab
            key={c.id}
            label={c.name}
            color={c.color}
            active={selected === c.id}
            onClick={() => onSelect(c.id)}
          />
        ))}
      </nav>
    </section>
  );
}

function Tab({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2 py-1 font-body text-[13px] transition-colors"
      style={{
        color: active ? 'var(--color-ink)' : 'var(--color-ink-muted)',
      }}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.55 }}
          aria-hidden="true"
        />
      )}
      <span
        className="tracking-tight group-hover:text-[color:var(--color-ink)]"
        style={{
          borderBottom: active
            ? '1.5px solid var(--color-accent)'
            : '1.5px solid transparent',
          paddingBottom: 1,
        }}
      >
        {label}
      </span>
    </button>
  );
}
