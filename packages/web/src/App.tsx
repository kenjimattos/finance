import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Onboarding } from './screens/Onboarding';
import { Dashboard } from './screens/Dashboard';

/**
 * App is a thin router between two mutually-exclusive states:
 *  - No item linked yet                       → Onboarding screen
 *  - At least one item (we only use the first) → Dashboard screen
 *
 * Single-user by design: the first item wins. If the user ever connects
 * multiple cards, a picker can be added here without touching anything else.
 */
export function App() {
  const itemsQ = useQuery({ queryKey: ['items'], queryFn: api.listItems });

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
          ) : (
            <Dashboard itemId={itemsQ.data[0].id} />
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
