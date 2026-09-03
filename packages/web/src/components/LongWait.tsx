import { useEffect, useState } from 'react';

/**
 * Progress readout for a wait measured in tens of seconds.
 *
 * A reconcile is ~75s of which ~99% is one model call (see the [extract] logs),
 * so there is no real percentage to report — the honest thing to show is which
 * step is running, how long it has been running, and what to expect. A ticking
 * counter is what separates "working" from "hung"; a fake progress bar would
 * just be a percentage we made up.
 */

export type WaitStep = {
  key: string;
  label: string;
  /** What to expect, shown while this step runs. */
  hint?: string;
  /** Shown instead of `hint` once the step passes SLOW_AFTER_SECONDS. */
  slowHint?: string;
};

const SLOW_AFTER_SECONDS = 90;

export function LongWait({ steps, activeKey }: { steps: WaitStep[]; activeKey: string | null }) {
  const [elapsed, setElapsed] = useState(0);

  // Restart the count on every step change, so the number always refers to the
  // step it sits next to.
  useEffect(() => {
    if (!activeKey) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [activeKey]);

  if (!activeKey) return null;
  const activeIndex = steps.findIndex((s) => s.key === activeKey);
  if (activeIndex < 0) return null;
  const active = steps[activeIndex];
  const hint = elapsed >= SLOW_AFTER_SECONDS ? (active.slowHint ?? active.hint) : active.hint;

  return (
    <div className="mt-6 border-t border-[color:var(--color-rule)] pt-4">
      {/* Only the step labels are announced. The seconds counter is
          aria-hidden: in a live region it would be read aloud every tick. */}
      <ol className="space-y-1.5" aria-live="polite">
        {steps.map((step, i) => {
          const done = i < activeIndex;
          const isActive = i === activeIndex;
          return (
            <li
              key={step.key}
              className={`flex items-baseline gap-2 font-mono text-sm ${
                isActive
                  ? 'text-[color:var(--color-ink)]'
                  : 'text-[color:var(--color-ink-muted)]'
              }`}
            >
              <span
                aria-hidden
                className={`inline-block w-3 ${isActive ? 'animate-pulse' : ''}`}
              >
                {done ? '✓' : isActive ? '·' : ''}
              </span>
              <span>{step.label}</span>
              {isActive && (
                <span
                  aria-hidden
                  className="ml-auto tabular-nums text-[color:var(--color-ink-muted)]"
                >
                  {elapsed}s
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {hint && (
        <p className="mt-3 font-body text-xs text-[color:var(--color-ink-muted)]">{hint}</p>
      )}
    </div>
  );
}
