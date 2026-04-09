import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';

/**
 * Global toast/snackbar with optional undo action.
 *
 * Design decisions:
 *
 *  - ONE toast at a time. Firing a new toast while one is visible
 *    replaces it instantly. If the user is doing fast back-to-back
 *    actions (common in the categorization inbox), they care about
 *    the most recent one anyway.
 *  - Bottom-center position, same horizontal axis as the existing
 *    bulk-action bar in TransactionInbox, so the app has a single
 *    convention for "floating confirmations from the bottom".
 *  - 6 second default dismiss. Hovering pauses the countdown so the
 *    user has time to read and click undo without racing the timer.
 *  - Optional `undo` callback. When provided the toast renders an
 *    inline "desfazer" link. Clicking it calls undo() AND dismisses
 *    the toast immediately.
 */

export interface ToastOptions {
  message: string;
  undo?: () => void | Promise<void>;
  durationMs?: number;
}

interface ToastState extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  show: (options: ToastOptions) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const idRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  const remainingRef = useRef(0);
  const startedAtRef = useRef(0);

  const dismiss = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const scheduleDismiss = useCallback(
    (ms: number) => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      startedAtRef.current = Date.now();
      remainingRef.current = ms;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setToast(null);
      }, ms);
    },
    [],
  );

  const show = useCallback(
    (options: ToastOptions) => {
      idRef.current += 1;
      const id = idRef.current;
      setToast({ ...options, id });
      scheduleDismiss(options.durationMs ?? 6000);
    },
    [scheduleDismiss],
  );

  // Pause countdown on hover, resume on leave.
  const onPause = useCallback(() => {
    if (timerRef.current == null || pausedRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    pausedRef.current = true;
    const elapsed = Date.now() - startedAtRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
  }, []);

  const onResume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    scheduleDismiss(remainingRef.current);
  }, [scheduleDismiss]);

  // Cleanup any pending timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <ToastLayer
        toast={toast}
        onDismiss={dismiss}
        onPause={onPause}
        onResume={onResume}
      />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be called inside <ToastProvider>');
  return ctx;
}

function ToastLayer({
  toast,
  onDismiss,
  onPause,
  onResume,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  return createPortal(
    <AnimatePresence>
      {toast && (
        <motion.div
          key={toast.id}
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.2, 0.65, 0.3, 0.9] }}
          onMouseEnter={onPause}
          onMouseLeave={onResume}
          className="fixed bottom-6 left-1/2 z-[1100] -translate-x-1/2 border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] px-5 py-3 shadow-[6px_6px_0_0_var(--color-ink)]"
        >
          <div className="flex items-center gap-5">
            <span className="font-body text-sm text-[color:var(--color-ink)]">
              {toast.message}
            </span>
            {toast.undo && (
              <button
                type="button"
                onClick={async () => {
                  await toast.undo?.();
                  onDismiss();
                }}
                className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-accent)] transition-opacity hover:opacity-70"
              >
                desfazer
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Fechar"
              className="font-mono text-sm text-[color:var(--color-ink-faint)] hover:text-[color:var(--color-ink)]"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
