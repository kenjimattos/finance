import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Account, Item } from '../../lib/apiTypes';
import { formatBRL, formatDelta } from '../../lib/format';
import { keys } from '../../lib/queryKeys';
import { sumBillBreakdowns } from '../../lib/overviewAggregates';
import type { AccountWithSettings } from '../../lib/useCreditAccounts';
import { AccountCard, UnconfiguredCard } from './AccountCard';
import { CategoryBreakdown } from './CategoryBreakdown';

/**
 * Cartões: every configured card's bill due this month, with the grand total,
 * delta and aggregated categories. The API resolves which cycle is due in
 * `month` on its own clock and returns that cycle's `offset`, which the
 * drill-down into Dashboard reuses.
 */
export function CardsSection({
  month,
  monthLabel,
  configured,
  unconfigured,
  loading,
  onSelectAccount,
}: {
  /** YYYY-MM */
  month: string;
  monthLabel: string;
  configured: AccountWithSettings[];
  unconfigured: { item: Item; account: Account }[];
  loading: boolean;
  onSelectAccount: (itemId: string, accountId: string, offset: number) => void;
}) {
  const breakdownQueries = useQueries({
    queries: configured.map(({ item, account }) => ({
      queryKey: keys.billBreakdown.dueIn(item.id, account.id, month),
      queryFn: () => api.getBillBreakdown(item.id, account.id, { dueMonth: month }),
    })),
  });

  const { total: grandTotal, delta: grandDelta, categories: aggregatedCategories } =
    sumBillBreakdowns(
      breakdownQueries.flatMap((q) => (q.data ? [q.data] : [])),
    );

  return (
    <div>
      <div className="eyebrow mb-6 uppercase">cartões</div>

      {/* Grand total + delta */}
      <div className="mb-6">
        <div className="font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]">
          {loading ? (
            <span className="inline-block h-12 w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)]" />
          ) : (
            formatBRL(grandTotal)
          )}
        </div>

        {!loading && (() => {
          const d = formatDelta(grandDelta);
          const dir = grandDelta > 0.01 ? 'higher' : grandDelta < -0.01 ? 'lower' : 'flat';
          return (
            <div className="mt-2 flex items-center gap-2 font-body text-sm text-[color:var(--color-ink-muted)]">
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
              <span>
                {d.text}{' '}
                <span className="text-[color:var(--color-ink-faint)]">vs anterior</span>
              </span>
            </div>
          );
        })()}

        <p className="mt-2 font-body text-sm text-[color:var(--color-ink-muted)]">
          {configured.length} {configured.length === 1 ? 'fatura' : 'faturas'} com vencimento em {monthLabel}
        </p>

        {/* Category breakdown */}
        {aggregatedCategories.length > 0 && (
          <CategoryBreakdown categories={aggregatedCategories} />
        )}
      </div>

      {/* Account cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-tour="cartoes">
        {configured.map(({ item, account, settings }, i) => {
          const bq = breakdownQueries[i];
          const breakdown = bq?.data ?? null;

          return (
            <AccountCard
              key={account.id}
              item={item}
              account={account}
              settings={settings}
              breakdown={breakdown}
              loading={bq?.isLoading ?? false}
              onClick={() => {
                if (breakdown) onSelectAccount(item.id, account.id, breakdown.offset);
              }}
            />
          );
        })}

        {unconfigured.map(({ item, account }) => (
          <UnconfiguredCard
            key={account.id}
            item={item}
            account={account}
            onClick={() => onSelectAccount(item.id, account.id, 0)}
          />
        ))}
      </div>
    </div>
  );
}
