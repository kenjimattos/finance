import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './lib/api';
import { GuidedTour, overviewTourSteps } from './components/GuidedTour';
import { Login } from './screens/Login';
import { Skeleton } from './components/Skeleton';
import { ErrorBanner } from './components/ErrorBanner';
import { Onboarding } from './screens/Onboarding';
import { Overview } from './screens/Overview';
import { Dashboard } from './screens/Dashboard';
import { CashFlow } from './screens/CashFlow';
import { SharedCardDetail } from './screens/SharedCardDetail';

/**
 * App routes between four screens:
 *  - No item linked → Onboarding
 *  - Items exist → Overview (landing: Caixa + Cartões)
 *  - "ver extrato" in Overview → CashFlow (detailed ledger)
 *  - Click account card → Dashboard (per-account detail)
 */
export function App() {
  const queryClient = useQueryClient();
  const authQ = useQuery({
    queryKey: ['auth'],
    queryFn: api.getAuthMe,
    retry: false,
  });

  const itemsQ = useQuery({
    queryKey: ['items'],
    queryFn: api.listItems,
    enabled: authQ.data?.authenticated === true,
  });

  const [overviewMonth, setOverviewMonth] = useState<{
    year: number;
    month: number;
  } | null>(null);

  const [drillDown, setDrillDown] = useState<{
    itemId: string;
    accountId: string;
    offset: number;
  } | null>(null);

  const [partnerDrill, setPartnerDrill] = useState<{
    owner: string;
    accountId: string;
    offset: number;
  } | null>(null);

  const [cashflowOpen, setCashflowOpen] = useState(false);

  // First visit = arrived without a valid auth cookie. When that visitor
  // logs in, walk them through the Overview once; skipping or finishing
  // dismisses it for the rest of the session.
  const [tourPending, setTourPending] = useState(false);
  useEffect(() => {
    if (authQ.data && !authQ.data.authenticated) setTourPending(true);
  }, [authQ.data]);

  if (authQ.isLoading) {
    return (
      <>
        <div className="page-rule" aria-hidden="true" />
        <Skeleton />
      </>
    );
  }

  if (!authQ.data?.authenticated) {
    return (
      <>
        <div className="page-rule" aria-hidden="true" />
        <Login
          onAuthenticated={() =>
            queryClient.invalidateQueries({ queryKey: ['auth'] })
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="page-rule" aria-hidden="true" />
      <main className="relative z-10 mx-auto max-w-[1200px] px-6 pt-16 pb-24 md:px-12 lg:pl-24">
        {itemsQ.isLoading && <Skeleton />}
        {itemsQ.isError && (
          <ErrorBanner
            message="Não foi possível falar com o backend. Verifique se ele está rodando em localhost:3333."
          />
        )}
        {itemsQ.data &&
          (itemsQ.data.length === 0 ? (
            <Onboarding />
          ) : drillDown ? (
            <Dashboard
              itemId={drillDown.itemId}
              accountId={drillDown.accountId}
              initialOffset={drillDown.offset}
              onBack={() => setDrillDown(null)}
            />
          ) : partnerDrill ? (
            <SharedCardDetail
              owner={partnerDrill.owner}
              accountId={partnerDrill.accountId}
              initialOffset={partnerDrill.offset}
              onBack={() => setPartnerDrill(null)}
            />
          ) : cashflowOpen ? (
            <CashFlow
              onSelectBill={(year, month) => {
                setCashflowOpen(false);
                setOverviewMonth({ year, month });
              }}
              onBack={() => setCashflowOpen(false)}
            />
          ) : (
            <>
              <Overview
                items={itemsQ.data}
                targetMonth={overviewMonth}
                onMonthChange={setOverviewMonth}
                onSelectAccount={(itemId, accountId, offset) =>
                  setDrillDown({ itemId, accountId, offset })
                }
                onSelectPartnerCard={(owner, accountId, offset) =>
                  setPartnerDrill({ owner, accountId, offset })
                }
                onOpenCashFlow={() => setCashflowOpen(true)}
              />
              {tourPending && (
                <GuidedTour
                  steps={overviewTourSteps}
                  onClose={() => setTourPending(false)}
                />
              )}
            </>
          ))}
      </main>
    </>
  );
}