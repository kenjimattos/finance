import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  cardGroupFilterToQuery,
  type CardGroupFilter,
  type Account,
} from '../lib/api';
import { CardSettingsSetup } from '../components/CardSettingsSetup';
import { BillCardGrid } from '../components/BillCardGrid';
import { CategoryTabs, type CategoryTabFilter } from '../components/CategoryTabs';
import { TransactionInbox } from '../components/TransactionInbox';
import { CardGroupsManager } from '../components/CardGroupsManager';
import { RulesManager } from '../components/RulesManager';
import { SplitSummaryCard } from '../components/SplitSummaryPanel';

/**
 * The main screen, once a card is linked.
 *
 * Flow:
 *  1. Fetch accounts for the item
 *  2. If no accounts yet (pre-sync), trigger a sync first
 *  3. Pick the first CREDIT account (or let the user choose via tabs)
 *  4. Check account settings → show setup if missing
 *  5. Show bill breakdown + transaction inbox scoped to that account
 */
export function Dashboard({
  itemId,
  accountId: accountIdFromOverview,
  initialOffset,
  onBack,
}: {
  itemId: string;
  /** When coming from Overview, the specific account to show. */
  accountId?: string;
  /** When coming from Overview, the bill offset for the target month. */
  initialOffset?: number;
  /** When set, renders a back button to return to the Overview. */
  onBack?: () => void;
}) {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    accountIdFromOverview ?? null,
  );
  const [cardGroupFilter, setCardGroupFilter] = useState<CardGroupFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryTabFilter>('all');
  const [managerOpen, setManagerOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  // Fetch accounts. The first sync populates these.
  const accountsQ = useQuery({
    queryKey: ['accounts', itemId],
    queryFn: () => api.listAccounts(itemId),
  });

  const creditAccounts = useMemo(
    () => (accountsQ.data ?? []).filter((a) => a.type === 'CREDIT'),
    [accountsQ.data],
  );

  // Auto-select the first credit account when data arrives
  const accountId = selectedAccountId ?? creditAccounts[0]?.id ?? null;

  // If no accounts exist yet, the user needs to sync first. The onboarding
  // flow triggers a sync after connecting; existing users may hit this if
  // they upgrade before syncing. Show a sync prompt.
  if (accountsQ.isSuccess && creditAccounts.length === 0) {
    return <SyncPrompt itemId={itemId} />;
  }

  if (!accountId) {
    return (
      <div className="opacity-50">
        <div className="eyebrow mb-4">carregando contas</div>
        <div className="h-24 w-2/3 rounded-sm bg-[color:var(--color-paper-tint)]" />
      </div>
    );
  }

  return (
    <>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="eyebrow mb-6 flex items-center gap-2 transition-colors hover:text-[color:var(--color-accent)]"
        >
          ← voltar
        </button>
      )}
      {creditAccounts.length > 1 && (
        <AccountSelector
          accounts={creditAccounts}
          selected={accountId}
          onSelect={(id) => {
            setSelectedAccountId(id);
            setCardGroupFilter('all');
            setCategoryFilter('all');
          }}
        />
      )}
      <AccountDashboard
        itemId={itemId}
        accountId={accountId}
        initialOffset={initialOffset}
        cardGroupFilter={cardGroupFilter}
        setCardGroupFilter={setCardGroupFilter}
        categoryFilter={categoryFilter}
        setCategoryFilter={setCategoryFilter}
        managerOpen={managerOpen}
        setManagerOpen={setManagerOpen}
        rulesOpen={rulesOpen}
        setRulesOpen={setRulesOpen}
      />
    </>
  );
}

/**
 * Everything that was in Dashboard before, but scoped to a single account.
 */
function AccountDashboard({
  itemId,
  accountId,
  initialOffset,
  cardGroupFilter,
  setCardGroupFilter,
  categoryFilter,
  setCategoryFilter,
  managerOpen,
  setManagerOpen,
  rulesOpen,
  setRulesOpen,
}: {
  itemId: string;
  accountId: string;
  /** Starting bill offset — set when drilling in from the Overview. */
  initialOffset?: number;
  cardGroupFilter: CardGroupFilter;
  setCardGroupFilter: (f: CardGroupFilter) => void;
  categoryFilter: CategoryTabFilter;
  setCategoryFilter: (f: CategoryTabFilter) => void;
  managerOpen: boolean;
  setManagerOpen: (v: boolean) => void;
  rulesOpen: boolean;
  setRulesOpen: (v: boolean) => void;
}) {
  // Which bill cycle we're viewing: 0 = currently open, -N = N cycles in the past.
  // When coming from Overview, start at the offset for the target month.
  // Resets when switching account so the user always lands on "today" first.
  const [billOffset, setBillOffset] = useState(initialOffset ?? 0);
  useEffect(() => {
    setBillOffset(initialOffset ?? 0);
  }, [accountId, initialOffset]);

  const settingsQ = useQuery({
    queryKey: ['accountSettings', accountId],
    queryFn: () => api.getAccountSettings(accountId),
    retry: false,
  });

  const needsSetup =
    settingsQ.isError &&
    settingsQ.error instanceof ApiError &&
    settingsQ.error.status === 404;

  const breakdownQ = useQuery({
    queryKey: ['billBreakdown', itemId, accountId, billOffset],
    queryFn: () => api.getBillBreakdown(itemId, accountId, billOffset),
    enabled: !!settingsQ.data,
  });

  const selectedGroup = useMemo(() => {
    if (!breakdownQ.data) return null;
    if (cardGroupFilter === 'all') {
      return breakdownQ.data.groups.find((g) => g.groupId == null) ?? null;
    }
    if (cardGroupFilter === 'none') return null;
    return (
      breakdownQ.data.groups.find((g) => g.groupId === cardGroupFilter) ?? null
    );
  }, [breakdownQ.data, cardGroupFilter]);

  if (needsSetup) {
    return <CardSettingsSetup itemId={itemId} accountId={accountId} />;
  }

  if (settingsQ.isLoading || !breakdownQ.data) {
    return (
      <div className="opacity-50">
        <div className="eyebrow mb-4">carregando fatura</div>
        <div className="h-24 w-2/3 rounded-sm bg-[color:var(--color-paper-tint)]" />
      </div>
    );
  }

  const cardGroupQuery = cardGroupFilterToQuery(cardGroupFilter);

  return (
    <>
      <BillCardGrid
        breakdown={breakdownQ.data}
        itemId={itemId}
        accountId={accountId}
        selected={cardGroupFilter}
        onSelect={(f) => {
          setCardGroupFilter(f);
          setCategoryFilter('all');
        }}
        offset={billOffset}
        onChangeOffset={(next) => {
          // Right arrow is forward in time → cap at 0 (the open bill).
          // Left arrow is unbounded back into history.
          if (next > 0) return;
          setBillOffset(next);
          setCardGroupFilter('all');
          setCategoryFilter('all');
        }}
        onManageCards={() => setManagerOpen(true)}
        onManageRules={() => setRulesOpen(true)}
      />
      <SplitSummaryCard
        accountId={accountId}
        offset={billOffset}
        displayName={breakdownQ.data.displayName}
        dueDate={breakdownQ.data.dueDate}
      />
      <CategoryTabs
        categories={selectedGroup?.categories ?? []}
        selected={categoryFilter}
        onSelect={setCategoryFilter}
      />
      <TransactionInbox
        itemId={itemId}
        accountId={accountId}
        periodStart={breakdownQ.data.periodStart}
        periodEnd={breakdownQ.data.periodEnd}
        previousPeriodStart={breakdownQ.data.previousPeriodStart}
        previousPeriodEnd={breakdownQ.data.previousPeriodEnd}
        nextPeriodStart={breakdownQ.data.nextPeriodStart}
        nextPeriodEnd={breakdownQ.data.nextPeriodEnd}
        cardGroupQuery={cardGroupQuery}
        categoryFilter={categoryFilter}
      />
      {managerOpen && (
        <CardGroupsManager
          itemId={itemId}
          accountId={accountId}
          onClose={() => setManagerOpen(false)}
        />
      )}
      {rulesOpen && (
        <RulesManager onClose={() => setRulesOpen(false)} />
      )}
    </>
  );
}

/**
 * Shown when accounts haven't been synced yet (upgrade path from pre-phase-2).
 */
function SyncPrompt({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const syncQ = useQuery({
    queryKey: ['_sync_prompt', itemId],
    queryFn: async () => {
      await api.syncTransactions(itemId);
      // After sync, accounts are populated — invalidate so Dashboard re-renders.
      qc.invalidateQueries({ queryKey: ['accounts', itemId] });
      return true;
    },
  });

  return (
    <div className="opacity-70">
      <div className="eyebrow mb-4">
        {syncQ.isLoading ? 'Sincronizando contas…' : 'Nenhuma conta encontrada'}
      </div>
      {syncQ.isError && (
        <p className="text-sm text-[color:var(--color-accent)]">
          Erro ao sincronizar. Verifique a conexão.
        </p>
      )}
    </div>
  );
}

function AccountSelector({
  accounts,
  selected,
  onSelect,
}: {
  accounts: Account[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="mb-10 flex gap-1 border-b border-[color:var(--color-paper-rule)]">
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onSelect(a.id)}
          className={`
            px-4 py-3 font-body text-sm font-medium uppercase tracking-[0.1em]
            transition-colors -mb-px border-b-2
            ${
              a.id === selected
                ? 'border-[color:var(--color-accent)] text-[color:var(--color-accent)]'
                : 'border-transparent text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]'
            }
          `}
        >
          {a.name ?? a.number ?? 'Conta'}
        </button>
      ))}
    </nav>
  );
}
