import type { PartnerCard, PartnerCardBreakdown } from '../../lib/apiTypes';
import { formatBRL, formatDateLong } from '../../lib/format';

// ─── Partner (shared) account card ──────────────────────────────────

export function PartnerAccountCard({
  card,
  breakdown,
  loading,
  onClick,
}: {
  card: PartnerCard;
  breakdown: PartnerCardBreakdown | null;
  loading: boolean;
  onClick: () => void;
}) {
  const total = breakdown?.total ?? 0;
  const displayName =
    card.displayName ?? card.accountName ?? card.connectorName ?? 'Cartão';

  return (
    <div className="group relative flex flex-col items-start border border-dashed border-[color:var(--color-paper-rule)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-ink-muted)]">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full flex-col items-start text-left"
      >
        <span className="eyebrow mb-2 flex items-center gap-2 text-[color:var(--color-ink-muted)] transition-colors group-hover:text-[color:var(--color-accent)]">
          <span>{displayName}</span>
          <span className="rounded-sm border border-[color:var(--color-paper-rule)] px-1.5 py-[1px] text-[9px] tracking-[0.14em] text-[color:var(--color-ink-faint)]">
            {card.ownerUsername}
          </span>
        </span>

        {loading ? (
          <span className="inline-block h-10 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
        ) : (
          <span className="font-display text-[40px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
            {formatBRL(total)}
          </span>
        )}

        {breakdown && (
          <span className="mt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
            sua parte
          </span>
        )}

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

// ─── Partner category column (½ / dela) ────────────────────────────

export interface PartnerInstallmentItem {
  id: string;
  description: string | null;
  owes: number;
  installmentNumber: number;
  totalInstallments: number;
}

const PARTNER_INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

export function PartnerCategoryColumn({
  label,
  total,
  categories,
  installments,
  accent,
}: {
  label: string;
  total: number;
  categories: Array<{ id: number; name: string; color: string; total: number }>;
  installments: PartnerInstallmentItem[];
  accent?: boolean;
}) {
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;
  const totalColor = accent ? 'var(--color-accent)' : 'var(--color-ink)';
  const installmentsTotal = installments.reduce((acc, i) => acc + i.owes, 0);

  return (
    <div className="border border-[color:var(--color-paper-rule)] px-5 py-5">
      <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <div
        className="mt-1 font-display text-[32px] leading-none tracking-[-0.02em]"
        style={{ color: totalColor }}
      >
        {formatBRL(total)}
      </div>
      {categories.length > 0 ? (
        <ul className="mt-5 space-y-2.5">
          {categories.map((cat) => (
            <li key={cat.id}>
              <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
                <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
                <span
                  className="shrink-0 font-mono tabular-nums"
                  style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
                >
                  {formatBRL(cat.total)}
                </span>
              </div>
              <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
                <div
                  className="h-full"
                  style={{
                    background: cat.color,
                    width: `${Math.round((Math.max(0, cat.total) / denominator) * 100)}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 font-body text-xs text-[color:var(--color-ink-faint)]">
          Nada nesta categoria.
        </p>
      )}

      {installments.length > 0 && (
        <div className="mt-5 border-t border-[color:var(--color-paper-rule)] pt-3">
          <div className="mb-2.5 flex items-baseline justify-between gap-2">
            <span className="font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              parcelas · {installments.length}
            </span>
            <span
              className="font-mono text-[12px] tabular-nums"
              style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
            >
              {formatBRL(installmentsTotal)}
            </span>
          </div>
          <ul className="space-y-2">
            {installments.map((inst) => (
              <li
                key={inst.id}
                className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 font-body text-[12px]"
              >
                <span className="truncate text-[color:var(--color-ink-soft)]">
                  {(inst.description ?? '—').replace(PARTNER_INSTALLMENT_SUFFIX, '').trim() || '—'}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
                  {inst.installmentNumber}/{inst.totalInstallments}
                </span>
                <span
                  className="font-mono tabular-nums"
                  style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
                >
                  {formatBRL(inst.owes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
