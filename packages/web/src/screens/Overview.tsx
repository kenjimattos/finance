import { useState, useMemo } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { PluggyConnect } from 'react-pluggy-connect';
import { motion } from 'motion/react';
import { api, type Item, type Account, type AccountSettings, type BillBreakdown, ApiError } from '../lib/api';
import { formatBRL, formatDateLong } from '../lib/format';
import { findOffsetForDueMonth, currentDueMonth } from '../lib/billWindow';

// ─── Month label ────────────────────────────────────────────────────

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function addMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = month - 1 + delta;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: y, month: m };
}

// ─── Types ──────────────────────────────────────────────────────────

interface AccountWithSettings {
  item: Item;
  account: Account;
  settings: AccountSettings;
}

// ─── Overview ───────────────────────────────────────────────────────

export function Overview({
  items,
  onSelectAccount,
}: {
  items: Item[];
  onSelectAccount: (itemId: string, accountId: string, offset: number) => void;
}) {
  const today = useMemo(() => new Date(), []);

  // ── Gather all accounts + settings across all items ──

  const accountQueries = useQueries({
    queries: items.map((item) => ({
      queryKey: ['accounts', item.id],
      queryFn: () => api.listAccounts(item.id),
    })),
  });

  const allAccounts = useMemo(() => {
    const result: { item: Item; account: Account }[] = [];
    accountQueries.forEach((q, i) => {
      if (!q.data) return;
      const item = items[i];
      q.data
        .filter((a) => a.type === 'CREDIT')
        .forEach((account) => result.push({ item, account }));
    });
    return result;
  }, [accountQueries, items]);

  const settingsQueries = useQueries({
    queries: allAccounts.map(({ account }) => ({
      queryKey: ['accountSettings', account.id],
      queryFn: () => api.getAccountSettings(account.id),
      retry: false,
    })),
  });

  // Only accounts with configured settings participate in the overview.
  const configured = useMemo(() => {
    const result: AccountWithSettings[] = [];
    allAccounts.forEach(({ item, account }, i) => {
      const sq = settingsQueries[i];
      if (sq?.data) {
        result.push({ item, account, settings: sq.data });
      }
    });
    return result;
  }, [allAccounts, settingsQueries]);

  // ── Target month (initialized from the first account's current due month) ──

  const defaultMonth = useMemo(() => {
    if (configured.length === 0) return { year: today.getFullYear(), month: today.getMonth() + 1 };
    const s = configured[0].settings;
    return currentDueMonth({ closingDay: s.closing_day, dueDay: s.due_day }, today);
  }, [configured, today]);

  const [targetYear, setTargetYear] = useState<number | null>(null);
  const [targetMonth, setTargetMonth] = useState<number | null>(null);

  const year = targetYear ?? defaultMonth.year;
  const month = targetMonth ?? defaultMonth.month;

  const isCurrentMonth =
    year === defaultMonth.year && month === defaultMonth.month;

  function navigateMonth(delta: number) {
    const next = addMonth(year, month, delta);
    setTargetYear(next.year);
    setTargetMonth(next.month);
  }

  // ── Resolve offset per account and fetch breakdowns in parallel ──

  const accountOffsets = useMemo(
    () =>
      configured.map(({ settings }) => {
        const cs = { closingDay: settings.closing_day, dueDay: settings.due_day };
        return findOffsetForDueMonth(cs, year, month, today);
      }),
    [configured, year, month, today],
  );

  const breakdownQueries = useQueries({
    queries: configured.map(({ item, account }, i) => {
      const offset = accountOffsets[i];
      return {
        queryKey: ['billBreakdown', item.id, account.id, offset],
        queryFn: () => api.getBillBreakdown(item.id, account.id, offset ?? 0),
        enabled: offset !== null,
      };
    }),
  });

  // ── Grand total (categorized only — matches per-account totals) ──

  const grandTotal = useMemo(() => {
    let sum = 0;
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      const allSlot = q.data.groups.find((g) => g.groupId === null);
      if (allSlot) sum += allSlot.total;
    });
    return sum;
  }, [breakdownQueries]);

  const loading =
    accountQueries.some((q) => q.isLoading) ||
    settingsQueries.some((q) => q.isLoading);

  // ── Render ──

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Month navigation header */}
      <div className="mb-10">
        <div className="eyebrow flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigateMonth(-1)}
            aria-label="mês anterior"
            className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none"
          >
            ←
          </button>
          <span className="uppercase">{monthLabel(year, month)}</span>
          <button
            type="button"
            onClick={() => navigateMonth(1)}
            disabled={isCurrentMonth}
            aria-label="próximo mês"
            className="leading-none transition-colors hover:text-[color:var(--color-accent)] focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:text-[color:var(--color-ink-faint)] disabled:opacity-40"
          >
            →
          </button>
        </div>

        <div className="mt-3 font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
          {loading ? (
            <span className="inline-block h-[72px] w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)] md:h-[96px]" />
          ) : (
            formatBRL(grandTotal)
          )}
        </div>

        <p className="mt-3 font-body text-sm text-[color:var(--color-ink-muted)]">
          total de {configured.length} {configured.length === 1 ? 'fatura' : 'faturas'} com vencimento em {monthLabel(year, month)}
        </p>
      </div>

      {/* Account cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {configured.map(({ item, account, settings }, i) => {
          const offset = accountOffsets[i];
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
                if (offset !== null) {
                  onSelectAccount(item.id, account.id, offset);
                }
              }}
            />
          );
        })}

        <AddBankCard />
      </div>
    </motion.section>
  );
}

// ─── Account card ───────────────────────────────────────────────────

function AccountCard({
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
  const queryClient = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: () => api.deleteItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
    },
  });

  const allSlot = breakdown?.groups.find((g) => g.groupId === null);
  const total = allSlot?.total ?? 0;
  const displayName =
    settings.display_name ?? account.name ?? item.connector_name ?? 'Conta';

  return (
    <div className="group relative flex flex-col items-start border border-[color:var(--color-paper-rule)] px-5 py-5 text-left transition-colors hover:border-[color:var(--color-ink-muted)]">
      {/* Delete button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Remover "${displayName}" e todos os seus dados?`)) {
            deleteMut.mutate();
          }
        }}
        disabled={deleteMut.isPending}
        className="absolute top-3 right-3 font-body text-xs text-[color:var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[color:var(--color-accent)] group-hover:opacity-100 disabled:opacity-50"
        aria-label={`Remover ${displayName}`}
      >
        remover
      </button>

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

// ─── Add bank card ──────────────────────────────────────────────────

function AddBankCard() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);

  const tokenMut = useMutation({
    mutationFn: api.connectToken,
    onSuccess: ({ accessToken }) => setToken(accessToken),
  });

  const saveMut = useMutation({
    mutationFn: (itemId: string) => api.saveItem(itemId),
    onSuccess: (_data, itemId) => {
      setToken(null);
      // Sync the new item so accounts are populated
      api.syncTransactions(itemId).then(() => {
        queryClient.invalidateQueries({ queryKey: ['items'] });
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
      });
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => tokenMut.mutate()}
        disabled={tokenMut.isPending}
        className="flex flex-col items-center justify-center gap-2 border border-dashed border-[color:var(--color-paper-rule)] px-5 py-8 text-center transition-colors hover:border-[color:var(--color-ink-muted)] disabled:opacity-50"
      >
        <span className="font-display text-2xl text-[color:var(--color-ink-faint)]">+</span>
        <span className="eyebrow text-[color:var(--color-ink-muted)]">
          {tokenMut.isPending ? 'Abrindo…' : 'Adicionar banco'}
        </span>
      </button>

      {token && (
        <PluggyConnect
          connectToken={token}
          includeSandbox={true}
          language="pt"
          theme="light"
          onSuccess={({ item }) => saveMut.mutate(item.id)}
          onClose={() => setToken(null)}
          onError={() => setToken(null)}
        />
      )}
    </>
  );
}
