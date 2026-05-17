import { useTheme, type ThemeMode } from '../lib/theme';

const OPTIONS: Array<{ value: ThemeMode; label: string; aria: string }> = [
  { value: 'auto', label: 'auto', aria: 'usar tema do sistema' },
  { value: 'light', label: '☼', aria: 'tema claro' },
  { value: 'dark', label: '☾', aria: 'tema escuro' },
];

export function ThemeToggle() {
  const [mode, setMode] = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="tema"
      className="inline-flex items-center border border-[color:var(--color-paper-rule)]"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.aria}
            onClick={() => setMode(opt.value)}
            className={
              'font-body text-[11px] uppercase tracking-[0.14em] leading-none px-2.5 py-1.5 transition-colors ' +
              (active
                ? 'bg-[color:var(--color-ink)] text-[color:var(--color-paper)]'
                : 'text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]')
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
