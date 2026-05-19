import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import { formatBRL, formatDateLong, formatDelta } from '../lib/format';

/**
 * Read-only view of a partner's credit-card bill, scoped to the splits they
 * shared with the viewer. The viewer cannot categorize, edit, or remove
 * splits — control stays with whoever registered the transaction.
 */
export function SharedCardDetail({
  owner,
  accountId,
  initialOffset,
  onBack,
}: {
  owner: string;
  accountId: string;
  initialOffset: number;
  onBack: () => void;
}) {
  const [offset, setOffset] = useState(initialOffset);

  // Reset offset whenever we navigate to a different shared card so the
  // viewer doesn't carry "I was looking at bill -2" between cards.
  useEffect(() => {
    setOffset(initialOffset);
  }, [owner, accountId, initialOffset]);

  const q = useQuery({
    queryKey: ['partnerCardBreakdown', owner, accountId, offset],
    queryFn: () => api.getPartnerCardBreakdown(owner, accountId, offset),
  });

  const data = q.data;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      <div className="mb-10 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="eyebrow text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          ← voltar
        </button>
        <div className="eyebrow flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOffset((o) => o - 1)}
            aria-label="fatura anterior"
            className="leading-none transition-colors hover:text-[color:var(--color-accent)]"
          >
            ←
          </button>
          <span className="uppercase">
            {data ? `${data.periodStart} → ${data.periodEnd}` : '—'}
          </span>
          <button
            type="button"
            onClick={() => setOffset((o) => o + 1)}
            aria-label="próxima fatura"
            className="leading-none transition-colors hover:text-[color:var(--color-accent)]"
          >
            →
          </button>
        </div>
      </div>

      {/* Headline */}
      <div className="mb-10">
        <div className="eyebrow mb-2 flex items-center gap-2 text-[color:var(--color-ink-muted)]">
          <span>
            {data?.displayName ??
              data?.accountName ??
              data?.connectorName ??
              'Cartão'}
          </span>
          <span className="rounded-sm border border-[color:var(--color-paper-rule)] px-1.5 py-[1px] text-[9px] tracking-[0.14em] text-[color:var(--color-ink-faint)]">
            {owner}
          </span>
          <span className="text-[color:var(--color-ink-faint)]">· somente leitura</span>
        </div>
        <div className="font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]">
          {q.isLoading ? (
            <span className="inline-block h-12 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
          ) : (
            formatBRL(data?.total ?? 0)
          )}
        </div>
        {data && (() => {
          const d = formatDelta(data.delta);
          const dir = data.delta > 0.01 ? 'higher' : data.delta < -0.01 ? 'lower' : 'flat';
          return (
            <div className="mt-2 flex items-baseline gap-4 font-body text-sm text-[color:var(--color-ink-muted)]">
              <span>sua parte</span>
              {dir !== 'flat' && (
                <span className="flex items-center gap-1">
                  <span
                    className="font-mono"
                    style={{
                      color: dir === 'higher' ? 'var(--color-accent)' : 'var(--color-positive)',
                    }}
                  >
                    {d.symbol}
                  </span>
                  <span>
                    {d.text}{' '}
                    <span className="text-[color:var(--color-ink-faint)]">vs anterior</span>
                  </span>
                </span>
              )}
            </div>
          );
        })()}
        {data && (
          <p className="mt-2 font-body text-sm text-[color:var(--color-ink-muted)]">
            fecha{' '}
            <span className="text-[color:var(--color-ink-soft)]">
              {formatDateLong(data.closingDate)}
            </span>{' '}
            · vence{' '}
            <span className="text-[color:var(--color-ink-soft)]">
              {formatDateLong(data.dueDate)}
            </span>
          </p>
        )}
      </div>

      {/* Category breakdown */}
      {data && data.categories.length > 0 && (() => {
        const denom = data.categories.reduce((s, c) => s + Math.max(0, c.total), 0) || 1;
        return (
          <div className="mb-10">
            <div className="eyebrow mb-4 uppercase">categorias</div>
            <ul className="space-y-2.5">
              {data.categories.map((cat) => (
                <li key={cat.id}>
                  <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
                    <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
                    <span className="shrink-0 font-mono tabular-nums text-[color:var(--color-ink-muted)]">
                      {formatBRL(cat.total)}
                    </span>
                  </div>
                  <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
                    <div
                      className="h-full"
                      style={{
                        background: cat.color,
                        width: `${Math.round((Math.max(0, cat.total) / denom) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* Transaction list */}
      <div>
        <div className="eyebrow mb-4 uppercase">transações</div>
        {data?.transactions.length ? (
          <ul className="divide-y divide-[color:var(--color-paper-rule)]">
            {data.transactions.map((t) => (
              <li
                key={t.id}
                className="flex items-baseline justify-between gap-4 py-3 font-body text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
                      {t.splitType === 'half' ? '½' : 'dela'}
                    </span>
                    <span className="truncate text-[color:var(--color-ink)]">
                      {t.description ?? '—'}
                    </span>
                    {t.installmentNumber != null && t.totalInstallments != null && (
                      <span className="shrink-0 text-[10px] text-[color:var(--color-ink-faint)]">
                        {t.installmentNumber}/{t.totalInstallments}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-[color:var(--color-ink-muted)]">
                    <span>{formatDateLong(t.date)}</span>
                    {t.category && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: t.category.color }}
                        />
                        {t.category.name}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <span className="font-mono tabular-nums text-[color:var(--color-ink)]">
                    {formatBRL(t.owes)}
                  </span>
                  {t.splitType === 'half' && (
                    <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
                      total {formatBRL(t.amount)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma transação compartilhada nesta fatura.
          </p>
        )}
      </div>
    </motion.section>
  );
}
