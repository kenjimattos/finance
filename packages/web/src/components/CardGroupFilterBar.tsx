import { useQuery } from '@tanstack/react-query';
import { api, type CardGroup, type CardGroupFilter } from '../lib/api';

/**
 * Horizontal row of chips that filter the transaction list by card group.
 * Renders only when at least one group exists for the account. The bar
 * replaces the old per-group card grid — grouping still helps the user
 * scope the inbox, but no longer drives per-card totals.
 */
export function CardGroupFilterBar({
  itemId,
  accountId,
  selected,
  onSelect,
  onManageCards,
}: {
  itemId: string;
  accountId: string;
  selected: CardGroupFilter;
  onSelect: (f: CardGroupFilter) => void;
  onManageCards: () => void;
}) {
  const groupsQ = useQuery({
    queryKey: ['cardGroups', itemId, accountId],
    queryFn: () => api.listCardGroups(itemId, accountId),
  });

  const groups: CardGroup[] = groupsQ.data ?? [];

  return (
    <section className="rule-top mt-10 pt-6">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--color-accent)' }}
            aria-hidden="true"
          />
          <span className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-accent)]">
            Cartões
          </span>
          <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
            ({groups.length})
          </span>
        </div>
        <button
          type="button"
          onClick={onManageCards}
          className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          gerenciar
        </button>
      </div>
      {groups.length > 0 && (
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 font-body text-[12px]">
          <Chip
            label="todos"
            active={selected === 'all'}
            onClick={() => onSelect('all')}
          />
          {groups.map((g) => (
            <Chip
              key={g.id}
              label={g.name}
              color={g.color}
              active={selected === g.id}
              onClick={() => onSelect(g.id)}
            />
          ))}
          <Chip
            label="sem grupo"
            active={selected === 'none'}
            onClick={() => onSelect('none')}
          />
        </nav>
      )}
    </section>
  );
}

function Chip({
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
      className="group flex items-center gap-2 py-1 transition-colors"
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
