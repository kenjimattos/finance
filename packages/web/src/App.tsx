import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Onboarding } from './screens/Onboarding';
import { Overview } from './screens/Overview';
import { Dashboard } from './screens/Dashboard';
import { CashFlow } from './screens/CashFlow';

/**
 * App is a thin router between three mutually-exclusive states:
 *  - No item linked yet → Onboarding screen
 *  - Items exist, no account selected → Overview (all bills by month)
 *  - Drilled into a specific account → Dashboard for that account
 */
export function App() {
  const itemsQ = useQuery({ queryKey: ['items'], queryFn: api.listItems });

  // Drill-down state: when set, show Dashboard for that account.
  const [drillDown, setDrillDown] = useState<{
    itemId: string;
    accountId: string;
    offset: number;
  } | null>(null);

  // Cash flow screen toggle.
  const [showCashFlow, setShowCashFlow] = useState(false);

  // Persisted across Overview ↔ Dashboard transitions so "voltar"
  // returns to the same month the user was browsing.
  const [overviewMonth, setOverviewMonth] = useState<{
    year: number;
    month: number;
  } | null>(null);

  return (
    <>
      <div className="page-rule" aria-hidden="true" />
      <main className="relative z-10 mx-auto max-w-[960px] px-6 pt-16 pb-24 md:px-12 lg:pl-24">
        {itemsQ.isLoading && <Skeleton />}
        {itemsQ.isError && (
          <ErrorBanner
            message="Não foi possível falar com o backend. Verifique se ele está rodando em localhost:3333."
          />
        )}
        {itemsQ.data &&
          (itemsQ.data.length === 0 ? (
            <Onboarding />
          ) : showCashFlow ? (
            <CashFlow onBack={() => setShowCashFlow(false)} />
          ) : drillDown ? (
            <Dashboard
              itemId={drillDown.itemId}
              accountId={drillDown.accountId}
              initialOffset={drillDown.offset}
              onBack={() => setDrillDown(null)}
            />
          ) : (
            <Overview
              items={itemsQ.data}
              targetMonth={overviewMonth}
              onMonthChange={setOverviewMonth}
              onSelectAccount={(itemId, accountId, offset) =>
                setDrillDown({ itemId, accountId, offset })
              }
              onOpenCashFlow={() => setShowCashFlow(true)}
            />
          ))}
      </main>
    </>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6 opacity-50">
      <div className="eyebrow">carregando</div>
      <div className="h-16 w-2/3 rounded-sm bg-[color:var(--color-paper-tint)]" />
      <div className="h-4 w-1/3 rounded-sm bg-[color:var(--color-paper-tint)]" />
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rule-top rule-bottom py-6">
      <div className="eyebrow mb-2 text-[color:var(--color-accent)]">erro</div>
      <p className="font-display text-xl text-[color:var(--color-ink)]">{message}</p>
    </div>
  );
}
