import { useQuery, useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/queryKeys';
import { partnerInstallments, sumPartnerCategories } from '../../lib/overviewAggregates';
import { PartnerAccountCard, PartnerCategoryColumn } from './PartnerCards';

/** Compartilhados: partners' cards (read-only) and the viewer's ½ / dela share. */
export function PartnerSection({
  month,
  onSelectPartnerCard,
}: {
  /** YYYY-MM */
  month: string;
  onSelectPartnerCard: (owner: string, accountId: string, offset: number) => void;
}) {
  const partnerCardsQ = useQuery({
    queryKey: keys.partnerCards(),
    queryFn: api.listPartnerCards,
  });
  const partnerCards = partnerCardsQ.data ?? [];

  const partnerBreakdownQueries = useQueries({
    queries: partnerCards.map((c) => ({
      queryKey: keys.partnerCardBreakdown.dueIn(c.ownerUsername, c.accountId, month),
      queryFn: () =>
        api.getPartnerCardBreakdown(c.ownerUsername, c.accountId, { dueMonth: month }),
    })),
  });

  if (partnerCards.length === 0) return null;

  const loaded = partnerBreakdownQueries.flatMap((q) => (q.data ? [q.data] : []));
  const partnerCategorySummary = sumPartnerCategories(loaded);
  const installments = partnerInstallments(loaded);

  return (
      <div className="mt-14">
        <div className="eyebrow mb-6 uppercase">compartilhados</div>
        <p className="mb-6 font-body text-sm text-[color:var(--color-ink-muted)]">
          Cartões de parceiros que dividem despesas com você. Valores são a
          sua parte (½ pela metade, dela pelo total).
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {partnerCards.map((card, i) => {
            const bq = partnerBreakdownQueries[i];
            return (
              <PartnerAccountCard
                key={`${card.ownerUsername}:${card.accountId}`}
                card={card}
                breakdown={bq?.data ?? null}
                loading={bq?.isLoading ?? false}
                onClick={() => {
                  if (bq?.data) {
                    onSelectPartnerCard(card.ownerUsername, card.accountId, bq.data.offset);
                  }
                }}
              />
            );
          })}
        </div>

        {/* Aggregated category breakdown — ½ vs dela, separated */}
        {partnerCategorySummary.categories.length > 0 && (
          <div className="mt-8 grid gap-x-8 gap-y-8 md:grid-cols-2">
            <PartnerCategoryColumn
              label="½ metade"
              total={partnerCategorySummary.halfTotal}
              categories={partnerCategorySummary.categories
                .filter((c) => c.halfTotal > 0)
                .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.halfTotal }))
                .sort((a, b) => b.total - a.total)}
              installments={installments.half}
            />
            <PartnerCategoryColumn
              label="dela"
              total={partnerCategorySummary.theirsTotal}
              accent
              categories={partnerCategorySummary.categories
                .filter((c) => c.theirsTotal > 0)
                .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c.theirsTotal }))
                .sort((a, b) => b.total - a.total)}
              installments={installments.theirs}
            />
          </div>
        )}
      </div>
  );
}
