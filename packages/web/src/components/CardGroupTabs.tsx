import { useQuery } from '@tanstack/react-query';
import { api, type CardGroupFilter } from '../lib/api';

/**
 * Editorial tab bar across the top of the dashboard. Lists:
 *   [Todos] [group 1] [group 2] ... [sem grupo] [gerenciar]
 *
 * Selection drives a single filter state held in the Dashboard. Counts next
 * to each label are the group's member count (for user groups) or the count
 * of cards without a group (for "sem grupo"). "Todos" has no count — it
 * means exactly "no filter".
 *
 * The "gerenciar" action is a trailing link, not a tab, because its job is
 * different (open modal, not switch filter). Placed at the end so the main
 * interaction is still the tab row.
 */
export function CardGroupTabs({
  itemId,
  filter,
  onFilterChange,
  onManage,
}: {
  itemId: string;
  filter: CardGroupFilter;
  onFilterChange: (f: CardGroupFilter) => void;
  onManage: () => void;
}) {
  const groupsQ = useQuery({
    queryKey: ['cardGroups', itemId],
    queryFn: () => api.listCardGroups(itemId),
  });
  const cardsQ = useQuery({
    queryKey: ['cards', itemId],
    queryFn: () => api.listCards(itemId),
  });

  const groups = groupsQ.data ?? [];
  const ungroupedCount = (cardsQ.data ?? []).filter((c) => c.group == null).length;

  return (
    <nav className="rule-top rule-bottom mt-12 flex flex-wrap items-baseline gap-x-6 gap-y-2 py-4">
      <Tab
        label="Todos"
        active={filter === 'all'}
        onClick={() => onFilterChange('all')}
      />

      {groups.map((g) => (
        <Tab
          key={g.id}
          label={g.name}
          count={g.memberCount}
          color={g.color}
          active={filter === g.id}
          onClick={() => onFilterChange(g.id)}
        />
      ))}

      {ungroupedCount > 0 && (
        <Tab
          label="sem grupo"
          count={ungroupedCount}
          active={filter === 'none'}
          onClick={() => onFilterChange('none')}
          muted
        />
      )}

      <button
        type="button"
        onClick={onManage}
        className="ml-auto font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
      >
        gerenciar cartões →
      </button>
    </nav>
  );
}

function Tab({
  label,
  count,
  color,
  active,
  muted,
  onClick,
}: {
  label: string;
  count?: number;
  color?: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-baseline gap-2 py-1"
      style={{
        color: active
          ? 'var(--color-ink)'
          : muted
            ? 'var(--color-ink-faint)'
            : 'var(--color-ink-muted)',
      }}
    >
      {color && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.55 }}
          aria-hidden="true"
        />
      )}
      <span
        className="font-display text-lg tracking-tight transition-colors group-hover:text-[color:var(--color-ink)]"
        style={{
          borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
          paddingBottom: 2,
        }}
      >
        {label}
      </span>
      {count != null && (
        <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
          {count}
        </span>
      )}
    </button>
  );
}
