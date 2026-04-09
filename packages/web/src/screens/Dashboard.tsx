import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  cardGroupFilterToQuery,
  type CardGroupFilter,
} from '../lib/api';
import { CardSettingsSetup } from '../components/CardSettingsSetup';
import { BillHeader } from '../components/BillHeader';
import { TransactionInbox } from '../components/TransactionInbox';
import { CardGroupTabs } from '../components/CardGroupTabs';
import { CardGroupsManager } from '../components/CardGroupsManager';

/**
 * The main screen, once a card is linked.
 *
 * Three possible states:
 *  1. Card settings missing → show CardSettingsSetup (one-time form)
 *  2. Loading the open bill → minimal skeleton
 *  3. Loaded → CardGroupTabs + BillHeader + TransactionInbox
 *
 * The card group filter state is owned here (single source of truth) and
 * propagated down into BillHeader (for the total) and TransactionInbox
 * (for the list). A change to the filter invalidates both queries via their
 * cache keys — no manual refetch needed.
 */
export function Dashboard({ itemId }: { itemId: string }) {
  const [filter, setFilter] = useState<CardGroupFilter>('all');
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

  const cardGroupQuery = cardGroupFilterToQuery(filter);

  const billQ = useQuery({
    queryKey: ['currentBill', itemId, cardGroupQuery ?? 'all'],
    queryFn: () => api.getCurrentBill(itemId, cardGroupQuery),
    enabled: !!settingsQ.data,
  });

  if (needsSetup) {
    return <CardSettingsSetup itemId={itemId} />;
  }

  if (settingsQ.isLoading || !billQ.data) {
    return (
      <div className="opacity-50">
        <div className="eyebrow mb-4">carregando fatura</div>
        <div className="h-24 w-2/3 rounded-sm bg-[color:var(--color-paper-tint)]" />
      </div>
    );
  }

  return (
    <>
      <BillHeader bill={billQ.data} itemId={itemId} />
      <CardGroupTabs
        itemId={itemId}
        filter={filter}
        onFilterChange={setFilter}
        onManage={() => setManagerOpen(true)}
      />
      <TransactionInbox
        itemId={itemId}
        periodStart={billQ.data.periodStart}
        periodEnd={billQ.data.periodEnd}
        cardGroupQuery={cardGroupQuery}
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
