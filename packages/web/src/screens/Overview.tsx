import { useState, useMemo } from 'react';
import { useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { PluggyConnect } from 'react-pluggy-connect';
import { motion } from 'motion/react';
import { api, type Item, type Account, type AccountSettings, type BillBreakdown } from '../lib/api';
import { formatBRL, formatDateLong, formatDelta } from '../lib/format';
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
  targetMonth: controlledMonth,
  onMonthChange,
  onSelectAccount,
  onBack,
}: {
  items: Item[];
  /** Controlled month state — persisted in App so "voltar" restores it. */
  targetMonth: { year: number; month: number } | null;
  onMonthChange: (m: { year: number; month: number }) => void;
  onSelectAccount: (itemId: string, accountId: string, offset: number) => void;
  onBack: () => void;
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

  // Separate accounts into configured (have settings) and unconfigured (need setup).
  const { configured, unconfigured } = useMemo(() => {
    const configured: AccountWithSettings[] = [];
    const unconfigured: { item: Item; account: Account }[] = [];
    allAccounts.forEach(({ item, account }, i) => {
      const sq = settingsQueries[i];
      if (sq?.data) {
        configured.push({ item, account, settings: sq.data });
      } else if (sq?.isError) {
        // 404 = no settings yet → needs setup
        unconfigured.push({ item, account });
      }
    });
    return { configured, unconfigured };
  }, [allAccounts, settingsQueries]);

  // ── Target month (initialized from the first account's current due month) ──

  const defaultMonth = useMemo(() => {
    if (configured.length === 0) return { year: today.getFullYear(), month: today.getMonth() + 1 };
    const s = configured[0].settings;
    return currentDueMonth({ closingDay: s.closing_day, dueDay: s.due_day }, today);
  }, [configured, today]);

  const year = controlledMonth?.year ?? defaultMonth.year;
  const month = controlledMonth?.month ?? defaultMonth.month;

  const isCurrentMonth =
    year === defaultMonth.year && month === defaultMonth.month;

  function navigateMonth(delta: number) {
    const next = addMonth(year, month, delta);
    onMonthChange(next);
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

  const { grandTotal, grandDelta } = useMemo(() => {
    let total = 0;
    let delta = 0;
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      const allSlot = q.data.groups.find((g) => g.groupId === null);
      if (allSlot) {
        total += allSlot.total;
        delta += allSlot.delta;
      }
    });
    return { grandTotal: total, grandDelta: delta };
  }, [breakdownQueries]);

  // ── Aggregated category breakdown across all accounts ──

  const aggregatedCategories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string; total: number }>();
    breakdownQueries.forEach((q) => {
      if (!q.data) return;
      const allSlot = q.data.groups.find((g) => g.groupId === null);
      if (!allSlot) return;
      for (const cat of allSlot.categories) {
        const existing = map.get(cat.id);
        if (existing) {
          existing.total += cat.total;
        } else {
          map.set(cat.id, { ...cat });
        }
      }
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
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
      {/* Back to CashFlow */}
      <button
        type="button"
        onClick={onBack}
        className="eyebrow mb-6 inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-accent)]"
      >
        ← voltar
      </button>

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

        {!loading && (() => {
          const d = formatDelta(grandDelta);
          const dir = grandDelta > 0.01 ? 'higher' : grandDelta < -0.01 ? 'lower' : 'flat';
          return (
            <div className="mt-4 flex items-center gap-2 font-body text-sm text-[color:var(--color-ink-muted)]">
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

        <div className="mt-3 flex items-baseline justify-between gap-4">
          <p className="font-body text-sm text-[color:var(--color-ink-muted)]">
            total de {configured.length} {configured.length === 1 ? 'fatura' : 'faturas'} com vencimento em {monthLabel(year, month)}
          </p>
          <SyncAllButton items={items} />
        </div>

        {/* Category breakdown */}
        {aggregatedCategories.length > 0 && (
          <CategoryBreakdown categories={aggregatedCategories} />
        )}
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

        {unconfigured.map(({ item, account }) => (
          <UnconfiguredCard
            key={account.id}
            item={item}
            account={account}
            onClick={() => onSelectAccount(item.id, account.id, 0)}
          />
        ))}

        <AddBankCard />
      </div>
    </motion.section>
  );
}

// ─── Sync all button ────────────────────────────────────────────────

function SyncAllButton({ items }: { items: Item[] }) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await Promise.all(items.map((item) => api.syncTransactions(item.id)));
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['accountSettings'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch (err) {
      console.error('[SyncAll] failed:', err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={syncing}
      className="shrink-0 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
    >
      {syncing ? 'sincronizando…' : 'sincronizar ↻'}
    </button>
  );
}

// ─── Category breakdown ─────────────────────────────────────────────

const CATEGORY_COLLAPSE_LIMIT = 6;

function CategoryBreakdown({
  categories,
}: {
  categories: Array<{ id: number; name: string; color: string; total: number }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, CATEGORY_COLLAPSE_LIMIT);
  const hiddenCount = categories.length - CATEGORY_COLLAPSE_LIMIT;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div className="mt-8">
      <ul className="space-y-2.5">
        {visible.map((cat) => (
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
                  width: `${Math.round((Math.max(0, cat.total) / denominator) * 100)}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-3 font-body text-[11px] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
        </button>
      )}
    </div>
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

        {allSlot && (() => {
          const d = formatDelta(allSlot.delta);
          const dir = allSlot.delta > 0.01 ? 'higher' : allSlot.delta < -0.01 ? 'lower' : 'flat';
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

function UnconfiguredCard({
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

// ─── Add bank card ──────────────────────────────────────────────────

function AddBankCard() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'syncing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const tokenMut = useMutation({
    mutationFn: api.connectToken,
    onSuccess: ({ accessToken }) => setToken(accessToken),
  });

  async function handleConnect(itemId: string) {
    setToken(null);
    setErrorMsg(null);
    try {
      setStatus('saving');
      await api.saveItem(itemId);

      setStatus('syncing');
      await api.syncTransactions(itemId);

      // Refresh everything so the new account appears.
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['accountSettings'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown'] });
      setStatus('idle');
    } catch (err) {
      console.error('[AddBank] failed:', err);
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Erro desconhecido');
      // Still refresh — the item may have been saved even if sync failed.
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          tokenMut.mutate();
        }}
        disabled={tokenMut.isPending || status === 'saving' || status === 'syncing'}
        className="flex flex-col items-center justify-center gap-2 border border-dashed border-[color:var(--color-paper-rule)] px-5 py-8 text-center transition-colors hover:border-[color:var(--color-ink-muted)] disabled:opacity-50"
      >
        <span className="font-display text-2xl text-[color:var(--color-ink-faint)]">+</span>
        <span className="eyebrow text-[color:var(--color-ink-muted)]">
          {tokenMut.isPending
            ? 'Abrindo…'
            : status === 'saving'
              ? 'Salvando…'
              : status === 'syncing'
                ? 'Sincronizando…'
                : 'Adicionar banco'}
        </span>
        {(status === 'error' || tokenMut.isError) && (
          <span className="mt-1 font-body text-xs text-[color:var(--color-accent)]">
            {errorMsg ?? 'Falha ao abrir o widget. Tente novamente.'}
          </span>
        )}
      </button>

      {token && (
        <PluggyConnect
          connectToken={token}
          includeSandbox={true}
          language="pt"
          theme="light"
          onSuccess={({ item }) => handleConnect(item.id)}
          onClose={() => setToken(null)}
          onError={() => setToken(null)}
        />
      )}
    </>
  );
}
