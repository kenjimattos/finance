import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api, type Card, type CardGroup } from '../lib/api';
import { formatDateShort } from '../lib/format';

/**
 * Full-screen overlay for managing card groups.
 *
 * Two stacked sections:
 *
 *  1. Grupos — list of existing groups (name + member count + color dot),
 *     with an inline "criar grupo" form at the bottom.
 *
 *  2. Cartões — one row per discovered card_last4, each with an inline
 *     dropdown to assign or re-assign a group. Cards without a group are
 *     shown first to draw the eye.
 *
 * Closing the overlay invalidates every query that the filter bar and the
 * dashboard depend on — membership changes are observable without the
 * user having to hit "sincronizar".
 */
export function CardGroupsManager({
  itemId,
  onClose,
}: {
  itemId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const groupsQ = useQuery({
    queryKey: ['cardGroups', itemId],
    queryFn: () => api.listCardGroups(itemId),
  });
  const cardsQ = useQuery({
    queryKey: ['cards', itemId],
    queryFn: () => api.listCards(itemId),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['cardGroups', itemId] });
    queryClient.invalidateQueries({ queryKey: ['cards', itemId] });
    queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
    queryClient.invalidateQueries({ queryKey: ['currentBill', itemId] });
  }

  const groups = groupsQ.data ?? [];
  const cards = cardsQ.data ?? [];
  const sortedCards = [...cards].sort((a, b) => {
    // Ungrouped cards first (they're the ones needing attention)
    if ((a.group == null) !== (b.group == null)) return a.group == null ? -1 : 1;
    return b.lastUsed.localeCompare(a.lastUsed);
  });

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[900] flex items-start justify-center overflow-y-auto bg-[color:var(--color-ink)]/40 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] }}
        className="relative my-12 w-full max-w-[640px] border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] p-8 shadow-[8px_8px_0_0_var(--color-ink)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-4 top-4 font-mono text-lg text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
        >
          ✕
        </button>

        <div className="eyebrow mb-2">Gerenciar cartões</div>
        <h2 className="font-display text-4xl leading-tight tracking-tight text-[color:var(--color-ink)]">
          Grupos & cartões
        </h2>
        <p className="mt-3 max-w-[52ch] font-body text-sm text-[color:var(--color-ink-muted)]">
          Cada cartão físico tem últimos 4 dígitos próprios. Organize-os em
          grupos (titular, adicional, virtual, esposa…) para ver os totais
          separados na fatura.
        </p>

        <GroupsSection
          itemId={itemId}
          groups={groups}
          onChanged={invalidateAll}
        />

        <CardsSection
          itemId={itemId}
          cards={sortedCards}
          groups={groups}
          onChanged={invalidateAll}
        />
      </motion.div>
    </motion.div>,
    document.body,
  );
}

// -----------------------------------------------------------------------------
// Groups section
// -----------------------------------------------------------------------------

function GroupsSection({
  itemId,
  groups,
  onChanged,
}: {
  itemId: string;
  groups: CardGroup[];
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState('');

  const createMut = useMutation({
    mutationFn: (name: string) => api.createCardGroup(itemId, name),
    onSuccess: () => {
      setNewName('');
      onChanged();
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.renameCardGroup(id, name),
    onSuccess: onChanged,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteCardGroup(id),
    onSuccess: onChanged,
  });

  return (
    <section className="mt-8">
      <div className="eyebrow mb-3">Grupos</div>
      <ul className="divide-y divide-[color:var(--color-paper-rule)]">
        {groups.length === 0 && (
          <li className="py-3 font-body text-sm italic text-[color:var(--color-ink-faint)]">
            Nenhum grupo ainda — crie o primeiro abaixo.
          </li>
        )}
        {groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            onRename={(name) => renameMut.mutate({ id: g.id, name })}
            onDelete={() => deleteMut.mutate(g.id)}
          />
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) createMut.mutate(newName.trim());
        }}
        className="mt-4 flex items-center gap-3"
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nome do novo grupo…"
          className="flex-1 border-0 border-b border-[color:var(--color-ink-faint)] bg-transparent py-2 font-body text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
        />
        <button
          type="submit"
          disabled={!newName.trim() || createMut.isPending}
          className="border border-[color:var(--color-ink)] bg-[color:var(--color-ink)] px-4 py-2 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-paper)] transition-colors hover:bg-[color:var(--color-accent)] hover:border-[color:var(--color-accent)] disabled:opacity-40"
        >
          criar
        </button>
      </form>
    </section>
  );
}

function GroupRow({
  group,
  onRename,
  onDelete,
}: {
  group: CardGroup;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(group.name);

  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: group.color }}
        aria-hidden="true"
      />
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value.trim() && value !== group.name) onRename(value.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setValue(group.name);
              setEditing(false);
            }
          }}
          className="flex-1 border-0 border-b border-[color:var(--color-accent)] bg-transparent py-1 font-display text-base text-[color:var(--color-ink)] focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex-1 text-left font-display text-base text-[color:var(--color-ink)] hover:text-[color:var(--color-accent)]"
        >
          {group.name}
        </button>
      )}
      <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
        {group.memberCount} cartão{group.memberCount === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        onClick={() => {
          if (confirm(`Excluir grupo "${group.name}"? Os cartões voltam para "sem grupo".`)) {
            onDelete();
          }
        }}
        aria-label={`Excluir grupo ${group.name}`}
        className="font-body text-xs text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-accent)]"
      >
        remover
      </button>
    </li>
  );
}

// -----------------------------------------------------------------------------
// Cards section
// -----------------------------------------------------------------------------

function CardsSection({
  itemId,
  cards,
  groups,
  onChanged,
}: {
  itemId: string;
  cards: Card[];
  groups: CardGroup[];
  onChanged: () => void;
}) {
  const assignMut = useMutation({
    mutationFn: ({
      cardLast4,
      cardGroupId,
    }: {
      cardLast4: string;
      cardGroupId: number | null;
    }) => api.assignCardToGroup(cardLast4, itemId, cardGroupId),
    onSuccess: onChanged,
  });

  return (
    <section className="mt-10">
      <div className="eyebrow mb-3">Cartões detectados</div>
      <ul className="divide-y divide-[color:var(--color-paper-rule)]">
        {cards.length === 0 && (
          <li className="py-3 font-body text-sm italic text-[color:var(--color-ink-faint)]">
            Nenhum cartão detectado. Sincronize para carregar transações.
          </li>
        )}
        {cards.map((card) => (
          <li
            key={card.cardLast4}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-3"
          >
            <div>
              <div className="font-mono text-[15px] tracking-wider text-[color:var(--color-ink)]">
                ····{card.cardLast4}
              </div>
              <div className="mt-0.5 font-body text-[11px] text-[color:var(--color-ink-faint)]">
                {card.txCount} transações · última em {formatDateShort(card.lastUsed)}
              </div>
            </div>

            <GroupSelect
              value={card.group?.id ?? null}
              groups={groups}
              onChange={(id) =>
                assignMut.mutate({ cardLast4: card.cardLast4, cardGroupId: id })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function GroupSelect({
  value,
  groups,
  onChange,
}: {
  value: number | null;
  groups: CardGroup[];
  onChange: (id: number | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? null : Number(v));
      }}
      className="border border-[color:var(--color-paper-rule)] bg-[color:var(--color-paper-tint)] px-3 py-1.5 font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-ink-soft)] transition-colors hover:border-[color:var(--color-ink)] hover:bg-[color:var(--color-paper)] focus:border-[color:var(--color-accent)] focus:outline-none"
    >
      <option value="">sem grupo</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
