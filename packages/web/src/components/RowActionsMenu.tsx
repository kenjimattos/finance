import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';

/**
 * Small "more actions" menu anchored to a row-level trigger button.
 *
 * Rendered via React portal into document.body so it escapes every
 * stacking context in the transaction list (same technique used by
 * CategoryPicker — the category list would otherwise cover it).
 *
 * Positioning: on open, the menu measures the trigger's viewport rect
 * and places itself directly below, flipping upward when near the
 * bottom edge and right-aligning when near the right edge. Distances
 * are in CSS pixels and the menu width is fixed.
 *
 * Closes on: Escape, scroll outside the menu, resize, click outside.
 * Scroll inside the menu is ignored so the list itself can scroll.
 *
 * Kept intentionally separate from CategoryPicker even though they
 * share mechanics. The two have different content shapes (one has
 * a search input and mutation, the other is a flat list of actions)
 * and extracting a shared Popover abstraction for just these two
 * call sites would be premature.
 */

export interface RowAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Hint for styling — e.g. 'danger' makes it accent-colored */
  tone?: 'default' | 'danger';
}

const WIDTH = 240;
const MAX_HEIGHT = 280;

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export function RowActionsMenu({
  actions,
  ariaLabel = 'Mais ações',
}: {
  actions: RowAction[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
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
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex h-6 w-6 items-center justify-center font-mono text-[14px] leading-none text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-ink)]"
      >
        ⋯
      </button>
      <AnimatePresence>
        {open && rect && (
          <MenuPortal
            rect={rect}
            actions={actions}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function MenuPortal({
  rect,
  actions,
  onClose,
}: {
  rect: Rect;
  actions: RowAction[];
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    function onScroll(e: Event) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const position = computePosition(rect);

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
      <ul className="py-1">
        {actions.map((action, i) => (
          <li key={i}>
            <button
              type="button"
              disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return;
                action.onClick();
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left font-body text-sm transition-colors hover:bg-[color:var(--color-paper-tint)] disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                color:
                  action.tone === 'danger'
                    ? 'var(--color-accent)'
                    : 'var(--color-ink)',
              }}
            >
              {action.label}
            </button>
          </li>
        ))}
      </ul>
    </motion.div>,
    document.body,
  );
}

function computePosition(trigger: Rect): {
  top: number;
  left: number;
  flipUp: boolean;
} {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = trigger.bottom + margin;
  let left = trigger.left;
  let flipUp = false;

  // Flip up if there isn't enough room below
  if (top + MAX_HEIGHT > vh && trigger.top - MAX_HEIGHT - margin >= 0) {
    top = trigger.top - MAX_HEIGHT - margin;
    flipUp = true;
  }

  // Right-align to trigger if the menu would overflow the right edge.
  // For a trailing "..." button this is almost always the case.
  if (left + WIDTH > vw - margin) {
    left = Math.max(margin, trigger.right - WIDTH);
  }

  return { top, left, flipUp };
}
