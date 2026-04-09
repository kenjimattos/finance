import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { CardSettingsSetup } from '../components/CardSettingsSetup';
import { BillHeader } from '../components/BillHeader';
import { TransactionInbox } from '../components/TransactionInbox';

/**
 * The main screen, once a card is linked.
 *
 * Three possible states:
 *  1. Card settings missing → show CardSettingsSetup (one-time form)
 *  2. Loading the open bill → minimal skeleton
 *  3. Loaded → BillHeader + TransactionInbox
 */
export function Dashboard({ itemId }: { itemId: string }) {
  // Try to fetch settings — a 404 means "not configured yet", which is
  // the signal to show the setup form.
  const settingsQ = useQuery({
    queryKey: ['cardSettings', itemId],
    queryFn: () => api.getCardSettings(itemId),
    retry: false,
  });

  const needsSetup =
    settingsQ.isError &&
    settingsQ.error instanceof ApiError &&
    settingsQ.error.status === 404;

  const billQ = useQuery({
    queryKey: ['currentBill', itemId],
    queryFn: () => api.getCurrentBill(itemId),
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
      <TransactionInbox
        itemId={itemId}
        periodStart={billQ.data.periodStart}
        periodEnd={billQ.data.periodEnd}
      />
    </>
  );
}
