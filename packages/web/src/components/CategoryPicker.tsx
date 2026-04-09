import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { api, type Category } from '../lib/api';

/**
 * Keyboard-driven category picker.
 *
 * Rendered via a React portal into document.body so it escapes every
 * stacking context from the transaction table. Without the portal, the
 * dropdown sits inside its own row and gets covered by the rows below
 * because each row creates a new stacking context.
 *
 * Position is computed from the trigger's getBoundingClientRect() on
 * open (and on scroll/resize we just close — it's simpler and the user
 * can re-open easily). If the dropdown would overflow the right edge of
 * the viewport, it flips to align right-edge to the trigger instead. If
 * it would overflow the bottom, it flips above the trigger.
 */

const WIDTH = 320;
const MAX_HEIGHT = 320; // input + list cap

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

interface PickerProps {
  categories: Category[];
  triggerRect: Rect;
  onPick: (categoryId: number) => void;
  onClear?: () => void;
  onClose: () => void;
}

function CategoryPickerPortal({
  categories,
  triggerRect,
  onPick,
  onClear,
  onClose,
}: PickerProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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

  // Close on outside-click, scroll, resize, or Escape.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    // Close on scroll OUTSIDE the picker — that's the case where the trigger
    // moved and the dropdown would visually detach. Scroll INSIDE the picker
    // (the category list itself) is expected behavior and must not close.
    // Using capture:true to catch events in the document tree, then checking
    // the target so internal scroll is ignored.
    function onScroll(e: Event) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    }
    function onResize() {
      onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

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

  // Compute a viewport-pinned position that flips when near the edges.
  const position = computePosition(triggerRect);

  return createPortal(
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: position.flipUp ? 4 : -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: position.flipUp ? 4 : -4 }}
      transition={{ duration: 0.14 }}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: WIDTH,
        zIndex: 1000,
      }}
      className="overflow-hidden border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] shadow-[4px_4px_0_0_var(--color-ink)]"
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
        {onClear && (
          <li className="border-b border-[color:var(--color-paper-rule)]">
            <button
              type="button"
              onClick={onClear}
              className="flex w-full items-center gap-3 px-4 py-2 text-left font-body text-sm italic text-[color:var(--color-ink-muted)] transition-colors hover:bg-[color:var(--color-paper-tint)] hover:text-[color:var(--color-accent)]"
            >
              <span aria-hidden="true">×</span>
              <span>Remover categoria</span>
            </button>
          </li>
        )}
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
    </motion.div>,
    document.body,
  );
}

/**
 * Pin the dropdown to the trigger with automatic flip when near the
 * viewport edges. Distances are in CSS pixels.
 */
function computePosition(trigger: Rect): {
  top: number;
  left: number;
  flipUp: boolean;
} {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Default: below the trigger, left-aligned
  let top = trigger.bottom + margin;
  let left = trigger.left;
  let flipUp = false;

  // Flip up if there isn't enough room below
  if (top + MAX_HEIGHT > vh && trigger.top - MAX_HEIGHT - margin >= 0) {
    top = trigger.top - MAX_HEIGHT - margin;
    flipUp = true;
  }

  // Flip to right-aligned if there isn't enough room to the right
  if (left + WIDTH > vw - margin) {
    left = Math.max(margin, trigger.right - WIDTH);
  }

  return { top, left, flipUp };
}

/**
 * Inline trigger button. Holds the open state and, when open, captures
 * its own viewport rect so the portal can position the dropdown.
 */
export function CategoryTrigger({
  label,
  color,
  categories,
  onPick,
  onClear,
}: {
  label: string;
  color?: string | null;
  categories: Category[];
  onPick: (categoryId: number) => void;
  /** If present, renders a "Remover categoria" row at the top of the picker. */
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // When opening, capture the button's current viewport rect.
  // useLayoutEffect so the rect is measured before paint — avoids a
  // one-frame flash at (0,0) before the position is computed.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setRect({
      top: r.top,
      left: r.left,
      bottom: r.bottom,
      right: r.right,
      width: r.width,
      height: r.height,
    });
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
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
        {open && rect && (
          <CategoryPickerPortal
            categories={categories}
            triggerRect={rect}
            onPick={(id) => {
              onPick(id);
              setOpen(false);
            }}
            onClear={
              onClear
                ? () => {
                    onClear();
                    setOpen(false);
                  }
                : undefined
            }
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
