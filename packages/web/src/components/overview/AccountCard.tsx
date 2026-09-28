import type { Item, Account, AccountSettings, BillBreakdown } from '../../lib/apiTypes';
import { formatBRL, formatDateLong, formatDelta } from '../../lib/format';

// ─── Account card ───────────────────────────────────────────────────

export function AccountCard({
  item,
  account,
  settings,
  breakdown,
  loading,
  onClick,
}: {
  item: Item;
  account: Account;
  settings: AccountSettings;
  breakdown: BillBreakdown | null;
  loading: boolean;
  onClick: () => void;
}) {

  const total = breakdown?.total ?? 0;
  const displayName =
    settings.display_name ?? account.name ?? item.connector_name ?? 'Conta';

  return (
    <div className="group relative flex flex-col items-start border border-[color:var(--color-paper-rule)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-ink-muted)]">

      {/* Main clickable area */}
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-start text-left"
      >
        <span className="eyebrow mb-3 text-[color:var(--color-ink-muted)] transition-colors group-hover:text-[color:var(--color-accent)]">
          {displayName}
        </span>

        {loading ? (
          <span className="inline-block h-10 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
        ) : (
          <span className="font-display text-[40px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
            {formatBRL(total)}
          </span>
        )}

        {breakdown && (() => {
          const d = formatDelta(breakdown.delta);
          const dir = breakdown.delta > 0.01 ? 'higher' : breakdown.delta < -0.01 ? 'lower' : 'flat';
          return (
            <span className="mt-2 flex items-center gap-1.5 font-body text-xs text-[color:var(--color-ink-muted)]">
              <span
                className="font-mono"
                style={{
                  color: dir === 'higher' ? 'var(--color-accent)'
                    : dir === 'lower' ? 'var(--color-positive)'
                    : 'var(--color-ink-faint)',
                }}
              >
                {d.symbol}
              </span>
              <span>{d.text} <span className="text-[color:var(--color-ink-faint)]">vs ant.</span></span>
            </span>
          );
        })()}

        {breakdown && (
          <span className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-body text-xs text-[color:var(--color-ink-muted)]">
            <span>
              fecha{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.closingDate)}
              </span>
            </span>
            <span>
              vence{' '}
              <span className="text-[color:var(--color-ink-soft)]">
                {formatDateLong(breakdown.dueDate)}
              </span>
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

// ─── Unconfigured account card ──────────────────────────────────────

export function UnconfiguredCard({
  item,
  account,
  onClick,
}: {
  item: Item;
  account: Account;
  onClick: () => void;
}) {
  const displayName = account.name ?? item.connector_name ?? 'Conta';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start border border-dashed border-[color:var(--color-accent-soft)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-accent)]"
    >
      <span className="eyebrow mb-3 text-[color:var(--color-accent)]">
        {displayName}
      </span>
      <span className="font-body text-sm text-[color:var(--color-ink-muted)]">
        Configurar dia de fechamento e vencimento para incluir na visão geral.
      </span>
      <span className="mt-3 eyebrow text-[color:var(--color-accent)] transition-colors group-hover:text-[color:var(--color-ink)]">
        Configurar →
      </span>
    </button>
  );
}
