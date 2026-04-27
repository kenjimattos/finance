import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Transaction } from '../lib/api';
import { formatBRL } from '../lib/format';
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
   * Shift a transaction's bill cycle AND surface an undo toast. The shift
   * value is the NEW absolute shift (computed additively by TransactionRow
   * from the current tx.billShift). Undo restores the previous value.
   */
  function runShift(txId: string, shift: -1 | 0 | 1) {
    // Find the transaction so we know its previous shift for undo.
    const allTxs = [...uncategorized, ...categorized];
    const tx = allTxs.find((t) => t.id === txId);
    const previousShift = (tx?.billShift ?? 0) as -1 | 0 | 1;

    shiftMut.mutate(
      { txId, shift },
      {
        onSuccess: () => {
          const message =
            shift === 0
              ? 'Restaurada para a fatura original'
              : shift === 1
                ? 'Movida para a próxima fatura'
                : 'Movida para a fatura anterior';
          toast.show({
            message,
            undo: () => {
              shiftMut.mutate({ txId, shift: previousShift });
            },
          });
        },
      },
    );
  }

  // ── Manual transaction mutations ──
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const createManualMut = useMutation({
    mutationFn: (body: Parameters<typeof api.createManualTransaction>[0]) =>
      api.createManualTransaction(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
      setShowAddForm(false);
    },
  });

  const updateManualMut = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Parameters<typeof api.updateManualTransaction>[1];
    }) => api.updateManualTransaction(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
      setEditingTx(null);
    },
  });

  const deleteManualMut = useMutation({
    mutationFn: (id: string) => api.deleteManualTransaction(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
      toast.show({ message: 'Lançamento manual excluído' });
    },
  });

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

  // ── Split mutations ──
  const splitMut = useMutation({
    mutationFn: ({ txId, splitType }: { txId: string; splitType: 'half' | 'theirs' }) =>
      api.splitTransaction(txId, splitType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['splitSummary'] });
    },
  });

  const unsplitMut = useMutation({
    mutationFn: (txId: string) => api.unsplitTransaction(txId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['splitSummary'] });
    },
  });

  const bulkSplitMut = useMutation({
    mutationFn: ({ txIds, splitType }: { txIds: string[]; splitType: 'half' | 'theirs' }) =>
      api.bulkSplit(txIds, splitType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['splitSummary'] });
      setSelected(new Set());
    },
  });

  const bulkUnsplitMut = useMutation({
    mutationFn: (txIds: string[]) => api.bulkUnsplit(txIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      queryClient.invalidateQueries({ queryKey: ['splitSummary'] });
      setSelected(new Set());
    },
  });

  function runSplit(txId: string, splitType: 'half' | 'theirs' | null) {
    if (splitType === null) {
      unsplitMut.mutate(txId);
    } else {
      splitMut.mutate({ txId, splitType });
    }
  }

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

  const selectedTotal = useMemo(() => {
    const all: Transaction[] = txsQ.data ?? [];
    return all
      .filter((t) => selected.has(t.id))
      .reduce((sum, t) => sum + t.amount, 0);
  }, [txsQ.data, selected]);

  return (
    <div className="mt-20">
      <Section
        title="A categorizar"
        count={uncategorized.length}
        right={
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => {
                setEditingTx(null);
                setShowAddForm((v) => !v);
              }}
              className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)]"
            >
              {showAddForm ? 'cancelar' : '+ lançamento'}
            </button>
            {uncategorized.length > 0 && (
              <button
                type="button"
                onClick={() => toggleAll(uncategorized.map((t) => t.id))}
                className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
              >
                {uncategorized.every((t) => selected.has(t.id))
                  ? 'desmarcar'
                  : 'selecionar todas'}
              </button>
            )}
          </div>
        }
      >
        {showAddForm && (
          <ManualTransactionForm
            accountId={accountId}
            periodStart={periodStart}
            periodEnd={periodEnd}
            onSubmit={(body) => createManualMut.mutate(body)}
            onCancel={() => setShowAddForm(false)}
            busy={createManualMut.isPending}
          />
        )}
        {editingTx && (
          <ManualTransactionForm
            accountId={accountId}
            periodStart={periodStart}
            periodEnd={periodEnd}
            initial={editingTx}
            onSubmit={(body) =>
              updateManualMut.mutate({
                id: editingTx.id,
                body: {
                  date: body.date,
                  description: body.description,
                  amount: body.amount,
                  cardLast4: body.cardLast4 ?? null,
                },
              })
            }
            onCancel={() => setEditingTx(null)}
            busy={updateManualMut.isPending}
          />
        )}
        {txsQ.isLoading && <EmptyLine>Carregando lançamentos…</EmptyLine>}
        {txsQ.isSuccess && uncategorized.length === 0 && !showAddForm && (
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
              onSplit={(splitType) => runSplit(tx.id, splitType)}
              onEditManual={
                tx.source === 'manual'
                  ? () => {
                      setShowAddForm(false);
                      setEditingTx(tx);
                    }
                  : undefined
              }
              onDeleteManual={
                tx.source === 'manual'
                  ? () => deleteManualMut.mutate(tx.id)
                  : undefined
              }
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
                onSplit={(splitType) => runSplit(tx.id, splitType)}
                onEditManual={
                  tx.source === 'manual'
                    ? () => {
                        setShowAddForm(false);
                        setEditingTx(tx);
                      }
                    : undefined
                }
                onDeleteManual={
                  tx.source === 'manual'
                    ? () => deleteManualMut.mutate(tx.id)
                    : undefined
                }
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
              <span className="font-mono text-sm tabular-nums text-[color:var(--color-ink)]">
                {formatBRL(selectedTotal)}
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
              <span className="mx-1 text-[color:var(--color-ink-faint)]">|</span>
              <span className="font-body text-xs text-[color:var(--color-ink-faint)]">
                dividir
              </span>
              <button
                type="button"
                onClick={() =>
                  bulkSplitMut.mutate({
                    txIds: Array.from(selected),
                    splitType: 'half',
                  })
                }
                className="font-mono text-xs font-semibold text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)]"
              >
                ½
              </button>
              <button
                type="button"
                onClick={() =>
                  bulkSplitMut.mutate({
                    txIds: Array.from(selected),
                    splitType: 'theirs',
                  })
                }
                className="font-body text-xs text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)]"
              >
                dela
              </button>
              <button
                type="button"
                onClick={() =>
                  bulkUnsplitMut.mutate(Array.from(selected))
                }
                className="font-body text-xs text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
              >
                nenhum
              </button>
              <span className="mx-1 text-[color:var(--color-ink-faint)]">|</span>
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

/**
 * Inline form for creating or editing a manual bill transaction.
 * Matches the editorial/broadsheet visual language — no card, no rounded
 * corners, just fields on paper with a border-bottom rule.
 */
function ManualTransactionForm({
  accountId,
  periodStart,
  periodEnd,
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  initial?: Transaction;
  onSubmit: (body: {
    accountId: string;
    date: string;
    description: string;
    amount: number;
    cardLast4?: string;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const descRef = useRef<HTMLInputElement>(null);
  // Extract day/month/year from the initial date or default to periodEnd.
  const refDate = initial?.date ?? periodEnd.slice(0, 10);
  const [day, setDay] = useState(String(parseInt(refDate.slice(8, 10), 10)));
  const [month, setMonth] = useState(String(parseInt(refDate.slice(5, 7), 10)));
  const [year, setYear] = useState(refDate.slice(0, 4));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(
    initial ? String(Math.abs(initial.amount)) : '',
  );
  const [cardLast4, setCardLast4] = useState(initial?.cardLast4 ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(amount.replace(',', '.'));
    if (!description.trim() || isNaN(parsed) || parsed <= 0) return;
    const d = parseInt(day, 10);
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (
      isNaN(d) ||
      d < 1 ||
      d > 31 ||
      isNaN(m) ||
      m < 1 ||
      m > 12 ||
      isNaN(y) ||
      y < 2000 ||
      y > 2100
    ) return;
    const fullDate = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    onSubmit({
      accountId,
      date: fullDate,
      description: description.trim(),
      amount: parsed,
      cardLast4: cardLast4.trim() || undefined,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 border-b border-[color:var(--color-paper-rule)] pb-4"
    >
      <div className="grid grid-cols-[116px_1fr_110px_72px] items-end gap-3">
        <div className="grid grid-cols-[1fr_1fr_2fr] gap-1.5">
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              D
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={day}
              onChange={(e) => setDay(e.target.value.replace(/\D/g, ''))}
              placeholder="15"
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              M
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={month}
              onChange={(e) => setMonth(e.target.value.replace(/\D/g, ''))}
              placeholder="04"
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              Ano
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))}
              placeholder={periodEnd.slice(0, 4)}
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Descrição
          </label>
          <input
            ref={descRef}
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ex: UBER *EATS"
            autoFocus
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-body text-[15px] text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Valor (R$)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-mono text-[15px] tabular-nums text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Cartão
          </label>
          <input
            type="text"
            maxLength={20}
            value={cardLast4}
            onChange={(e) => setCardLast4(e.target.value)}
            placeholder="1234"
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-mono text-xs text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {initial ? 'salvar' : 'adicionar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
        >
          cancelar
        </button>
      </div>
    </form>
  );
}
