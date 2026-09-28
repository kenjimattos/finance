import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/queryKeys';
import { sumSplitSummaries } from '../../lib/overviewAggregates';
import type { AccountWithSettings } from '../../lib/useCreditAccounts';
import { SplitSection } from '../SplitSection';

/** Divisão: every configured card's split summary for the month, summed. */
export function SplitAggregateSection({
  month,
  configured,
}: {
  /** YYYY-MM */
  month: string;
  configured: AccountWithSettings[];
}) {
  const splitQueries = useQueries({
    queries: configured.map(({ account }) => ({
      queryKey: keys.splitSummary.dueIn(account.id, month),
      queryFn: () => api.getSplitSummary(account.id, { dueMonth: month }),
    })),
  });

  const aggregatedSplit = sumSplitSummaries(
    splitQueries.flatMap((q) => (q.data ? [q.data] : [])),
  );
  if (!aggregatedSplit) return null;

  return (
    <div data-tour="split">
      <SplitSection split={aggregatedSplit} variant="section" />
    </div>
  );
}
