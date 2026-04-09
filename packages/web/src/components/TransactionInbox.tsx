import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Transaction } from '../lib/api';
import type { CategoryTabFilter } from './CategoryTabs';
import { TransactionRow } from './TransactionRow';
import { CategoryTrigger } from './CategoryPicker';
import { useToast } from './Toast';

/**
 * The categorization inbox — the main work surface of the app.
 *
 * Top: "A categorizar" section with uncategorized transactions first.
 * Bottom: "Já categorizadas" section, collapsed by default (toggle).
 *
 * Selection model: each row has a checkbox, and when any row is selected
 * a floating bar appears with a single category picker that applies to
 * every selected row. This is the bulk-categorize flow the user asked for.
 */
export function TransactionInbox({
  itemId,
  accountId,
  periodStart,
  periodEnd,
  previousPeriodStart,
  previousPeriodEnd,
  nextPeriodStart,
  nextPeriodEnd,
  cardGroupQuery,
  categoryFilter,
}: {
  itemId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
  cardGroupQuery: string | undefined;
  categoryFilter: CategoryTabFilter;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCategorized, setShowCategorized] = useState(true);

  const txsQ = useQuery({
    queryKey: [
      'transactions',
      itemId,
      accountId,
      periodStart,
      periodEnd,
      cardGroupQuery ?? 'all',
    ],
    queryFn: () =>
      api.listTransactions({
        itemId,
        accountId,
        from: periodStart,
        to: periodEnd,
        previousFrom: previousPeriodStart,
        previousTo: previousPeriodEnd,
        nextFrom: nextPeriodStart,
        nextTo: nextPeriodEnd,
        cardGroupId: cardGroupQuery,
      }),
  });

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: api.listCategories,
  });

  const assignMut = useMutation({
    mutationFn: ({ txId, categoryId }: { txId: string; categoryId: number }) =>
      api.assignCategory(txId, categoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  const clearMut = useMutation({
    mutationFn: (txId: string) => api.clearCategory(txId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  const shiftMut = useMutation({
    mutationFn: ({ txId, shift }: { txId: string; shift: -1 | 0 | 1 }) =>
      api.shiftTransactionBill(txId, shift),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  /**
   * Shift a transaction's bill cycle AND surface an undo toast. After a
   * successful shift, the row drops out of the current list (the backend
   * query no longer returns it), so without undo there'd be no way to
   * recover from a mistaken click — we don't have historical bill
   * navigation yet. The toast holds that recovery window open for 6s.
   */
  function runShift(txId: string, shift: -1 | 0 | 1) {
    shiftMut.mutate(
      { txId, shift },
      {
        onSuccess: () => {
          if (shift === 0) return; // no toast needed for a restore
          const message =
            shift === 1
              ? 'Movida para a próxima fatura'
              : 'Movida para a fatura anterior';
          toast.show({
            message,
            undo: () => {
              shiftMut.mutate({ txId, shift: 0 });
            },
          });
        },
      },
    );
  }

  const bulkMut = useMutation({
    mutationFn: ({
      txIds,
      categoryId,
    }: {
      txIds: string[];
      categoryId: number;
    }) => api.bulkCategorize(txIds, categoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
      setSelected(new Set());
    },
  });

  // Apply the category tab filter on top of whatever came back from the
  // backend (which is already card-group-filtered). Filtering client-side
  // keeps /transactions simple and avoids an extra query parameter.
  //
  // Special case: when a category is selected, ONLY that category's
  // transactions make sense — uncategorized rows are hidden entirely,
  // because there's no way to compare "uncategorized" against "Alimentação".
  // Clearing the tab (selecting "Todas") brings them back.
  const { uncategorized, categorized } = useMemo(() => {
    const all: Transaction[] = txsQ.data ?? [];
    if (categoryFilter === 'all') {
      return {
        uncategorized: all.filter((t) => t.userCategory == null),
        categorized: all.filter((t) => t.userCategory != null),
      };
    }
    return {
      uncategorized: [] as Transaction[],
      categorized: all.filter(
        (t) => t.userCategory != null && t.userCategory.id === categoryFilter,
      ),
    };
  }, [txsQ.data, categoryFilter]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(ids: string[]) {
    setSelected((prev) => {
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  const categories = categoriesQ.data ?? [];

  return (
    <div className="mt-20">
      <Section
        title="A categorizar"
        count={uncategorized.length}
        right={
          uncategorized.length > 0 && (
            <button
              type="button"
              onClick={() => toggleAll(uncategorized.map((t) => t.id))}
              className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
            >
              {uncategorized.every((t) => selected.has(t.id))
                ? 'desmarcar'
                : 'selecionar todas'}
            </button>
          )
        }
      >
        {txsQ.isLoading && <EmptyLine>Carregando lançamentos…</EmptyLine>}
        {txsQ.isSuccess && uncategorized.length === 0 && (
          <EmptyLine>
            Tudo categorizado nesta fatura. Bom trabalho.
          </EmptyLine>
        )}
        <div className="divide-y divide-[color:var(--color-paper-rule)]">
          {uncategorized.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              categories={categories}
              selected={selected.has(tx.id)}
              onToggleSelected={() => toggle(tx.id)}
              onAssign={(categoryId) =>
                assignMut.mutate({ txId: tx.id, categoryId })
              }
              onClear={() => clearMut.mutate(tx.id)}
              onShift={(shift) => runShift(tx.id, shift)}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Já categorizadas"
        count={categorized.length}
        right={
          <button
            type="button"
            onClick={() => setShowCategorized((v) => !v)}
            className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
          >
            {showCategorized ? 'ocultar' : 'mostrar'}
          </button>
        }
      >
        {showCategorized && (
          <div className="divide-y divide-[color:var(--color-paper-rule)]">
            {categorized.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                categories={categories}
                selected={selected.has(tx.id)}
                onToggleSelected={() => toggle(tx.id)}
                onAssign={(categoryId) =>
                  assignMut.mutate({ txId: tx.id, categoryId })
                }
                onClear={() => clearMut.mutate(tx.id)}
                onShift={(shift) => runShift(tx.id, shift)}
              />
            ))}
            {categorized.length === 0 && (
              <EmptyLine>Nenhuma transação categorizada ainda.</EmptyLine>
            )}
          </div>
        )}
      </Section>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] }}
            className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] px-5 py-3 shadow-[6px_6px_0_0_var(--color-ink)]"
          >
            <div className="flex items-center gap-4">
              <span className="font-display text-lg text-[color:var(--color-ink)]">
                {selected.size} selecionada{selected.size > 1 ? 's' : ''}
              </span>
              <span className="font-body text-xs text-[color:var(--color-ink-faint)]">
                aplicar categoria em lote
              </span>
              <CategoryTrigger
                label="escolher…"
                categories={categories}
                onPick={(categoryId) =>
                  bulkMut.mutate({
                    txIds: Array.from(selected),
                    categoryId,
                  })
                }
              />
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
              >
                limpar
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({
  title,
  count,
  right,
  children,
}: {
  title: string;
  count: number;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 first:mt-0">
      <header className="mb-4 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="font-display text-2xl tracking-tight text-[color:var(--color-ink)]">
            {title}
          </h3>
          <span className="font-mono text-xs text-[color:var(--color-ink-faint)]">
            ({count})
          </span>
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 font-body text-sm italic text-[color:var(--color-ink-faint)]">
      {children}
    </p>
  );
}
