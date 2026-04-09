import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { api, type Category } from '../lib/api';

/**
 * Keyboard-driven category picker.
 *
 * Behavior:
 *  - Opens as a small overlay positioned where the trigger was clicked
 *  - Free-text input filters categories by substring (case-insensitive)
 *  - Arrow up/down + Enter for selection
 *  - If no match exists and the user presses Enter, a new category is created
 *    with the typed name (auto-assigned color) and immediately returned
 *  - Esc closes without selecting
 *
 * Kept self-contained: the trigger component feeds it onPick() and gets
 * called with the chosen categoryId. No context, no refs up the tree.
 */

export function CategoryPicker({
  categories,
  onPick,
  onClose,
}: {
  categories: Category[];
  onPick: (categoryId: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [query, categories]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const createMut = useMutation({
    mutationFn: (name: string) => api.createCategory(name),
    onSuccess: (cat) => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      onPick(cat.id);
    },
  });

  const canCreate =
    query.trim().length > 0 &&
    !filtered.some((c) => c.name.toLowerCase() === query.trim().toLowerCase());

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (cursor < filtered.length) {
        onPick(filtered[cursor].id);
      } else if (canCreate) {
        createMut.mutate(query.trim());
      }
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.14 }}
      className="absolute left-0 top-full z-20 mt-2 w-[320px] overflow-hidden border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] shadow-[4px_4px_0_0_var(--color-ink)]"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Buscar ou criar categoria…"
        className="w-full border-0 border-b border-[color:var(--color-paper-rule)] bg-transparent px-4 py-3 font-body text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] focus:outline-none"
      />

      <ul className="max-h-[240px] overflow-y-auto py-1">
        {filtered.map((cat, i) => (
          <li key={cat.id}>
            <button
              type="button"
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(cat.id)}
              className="flex w-full items-center gap-3 px-4 py-2 text-left font-body text-sm transition-colors"
              style={{
                background:
                  cursor === i ? 'var(--color-paper-tint)' : 'transparent',
                color: 'var(--color-ink)',
              }}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: cat.color }}
                aria-hidden="true"
              />
              <span className="flex-1">{cat.name}</span>
              {cat.usage_count > 0 && (
                <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
                  {cat.usage_count}
                </span>
              )}
            </button>
          </li>
        ))}

        {canCreate && (
          <li>
            <button
              type="button"
              onMouseEnter={() => setCursor(filtered.length)}
              onClick={() => createMut.mutate(query.trim())}
              disabled={createMut.isPending}
              className="flex w-full items-center gap-3 px-4 py-2 text-left font-body text-sm italic transition-colors disabled:opacity-50"
              style={{
                background:
                  cursor === filtered.length
                    ? 'var(--color-paper-tint)'
                    : 'transparent',
                color: 'var(--color-accent)',
              }}
            >
              <span aria-hidden="true">+</span>
              <span>Criar "{query.trim()}"</span>
            </button>
          </li>
        )}

        {filtered.length === 0 && !canCreate && (
          <li className="px-4 py-3 font-body text-xs text-[color:var(--color-ink-faint)]">
            Nenhuma categoria encontrada.
          </li>
        )}
      </ul>
    </motion.div>
  );
}

/**
 * Small convenience wrapper: renders an inline trigger button that toggles
 * the picker in place. Used by both the single-row pill and the bulk bar.
 */
export function CategoryTrigger({
  label,
  color,
  categories,
  onPick,
}: {
  label: string;
  color?: string | null;
  categories: Category[];
  onPick: (categoryId: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-2 border border-[color:var(--color-paper-rule)] bg-[color:var(--color-paper-tint)] px-2.5 py-1 font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-ink-soft)] transition-colors hover:border-[color:var(--color-ink)] hover:bg-[color:var(--color-paper)]"
      >
        {color && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: color }}
            aria-hidden="true"
          />
        )}
        <span>{label}</span>
        <span className="text-[color:var(--color-ink-faint)]">▾</span>
      </button>
      <AnimatePresence>
        {open && (
          <CategoryPicker
            categories={categories}
            onPick={(id) => {
              onPick(id);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
