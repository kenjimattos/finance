import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  cardGroupFilterToQuery,
  type CardGroupFilter,
} from '../lib/api';
import { CardSettingsSetup } from '../components/CardSettingsSetup';
import { BillCardGrid } from '../components/BillCardGrid';
import { CategoryTabs, type CategoryTabFilter } from '../components/CategoryTabs';
import { TransactionInbox } from '../components/TransactionInbox';
import { CardGroupsManager } from '../components/CardGroupsManager';

/**
 * The main screen, once a card is linked.
 *
 * Three possible states:
 *  1. Card settings missing → show CardSettingsSetup (one-time form)
 *  2. Loading the breakdown → minimal skeleton
 *  3. Loaded → BillCardGrid + CategoryTabs + TransactionInbox
 *
 * Two filters live here as state:
 *   - cardGroupFilter: which group-card is selected in the top grid. Drives
 *     both the transaction list (server-side via cardGroupId query) AND
 *     which card in the grid is highlighted. Also decides which categories
 *     show up as tabs (only the ones present in the selected card).
 *   - categoryFilter: which category tab is active. Applied client-side
 *     via Array.filter on the transaction list (no backend round-trip
 *     needed — the categories shown are derived from data already in
 *     the frontend).
 */
export function Dashboard({ itemId }: { itemId: string }) {
  const [cardGroupFilter, setCardGroupFilter] = useState<CardGroupFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryTabFilter>('all');
  const [managerOpen, setManagerOpen] = useState(false);

  const settingsQ = useQuery({
    queryKey: ['cardSettings', itemId],
    queryFn: () => api.getCardSettings(itemId),
    retry: false,
  });

  const needsSetup =
    settingsQ.isError &&
    settingsQ.error instanceof ApiError &&
    settingsQ.error.status === 404;

  const breakdownQ = useQuery({
    queryKey: ['billBreakdown', itemId],
    queryFn: () => api.getBillBreakdown(itemId),
    enabled: !!settingsQ.data,
  });

  // The categories that appear as tabs are the ones present in the currently
  // selected card (either "Todos" or a specific group). If the user picks a
  // category filter that isn't in the new selection, we reset it silently.
  const selectedGroup = useMemo(() => {
    if (!breakdownQ.data) return null;
    if (cardGroupFilter === 'all') {
      return breakdownQ.data.groups.find((g) => g.groupId == null) ?? null;
    }
    if (cardGroupFilter === 'none') return null; // "none" not shown as a card
    return (
      breakdownQ.data.groups.find((g) => g.groupId === cardGroupFilter) ?? null
    );
  }, [breakdownQ.data, cardGroupFilter]);

  if (needsSetup) {
    return <CardSettingsSetup itemId={itemId} />;
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
        selected={cardGroupFilter}
        onSelect={(f) => {
          setCardGroupFilter(f);
          setCategoryFilter('all'); // reset category when switching cards
        }}
        onManageCards={() => setManagerOpen(true)}
      />
      <CategoryTabs
        categories={selectedGroup?.categories ?? []}
        selected={categoryFilter}
        onSelect={setCategoryFilter}
      />
      <TransactionInbox
        itemId={itemId}
        periodStart={breakdownQ.data.periodStart}
        periodEnd={breakdownQ.data.periodEnd}
        cardGroupQuery={cardGroupQuery}
        categoryFilter={categoryFilter}
      />
      {managerOpen && (
        <CardGroupsManager
          itemId={itemId}
          onClose={() => setManagerOpen(false)}
        />
      )}
    </>
  );
}
