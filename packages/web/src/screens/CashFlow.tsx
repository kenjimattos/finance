import { useState, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import type { CashFlowEntry, CashFlowDay } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';

// ── Helpers ──

const MONTH_LABEL = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
});

function monthLabel(year: number, month: number): string {
  return MONTH_LABEL.format(new Date(year, month - 1, 1));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Stable, distinct colors for bank accounts. */
const BANK_COLORS = [
  '#2563eb', // blue
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#059669', // emerald
  '#d97706', // amber
];

// ── Main Component ──

interface CashFlowProps {
  onBack: () => void;
}

export function CashFlow({ onBack }: CashFlowProps) {
  const qc = useQueryClient();

  const cashflowQ = useQuery({
    queryKey: ['cashflow'],
    queryFn: api.getCashFlow,
  });

  const today = todayYmd();
  const data = cashflowQ.data;

  // Parse month for display.
  const [year, month] = data
    ? data.month.split('-').map(Number)
    : [new Date().getFullYear(), new Date().getMonth() + 1];

  // ── Bank account colors ──
  const bankColorMap = useMemo(() => {
    const map = new Map<string, string>();
    if (data?.bankAccounts) {
      data.bankAccounts.forEach((ba, i) => {
        map.set(ba.id, BANK_COLORS[i % BANK_COLORS.length]);
      });
    }
    return map;
  }, [data]);

  // ���─ Running balance ──
  const { dayBalances, endBalance, totalOpeningBalance } = useMemo(() => {
    if (!data?.bankAccounts?.length) {
      return { dayBalances: new Map<string, number>(), endBalance: null, totalOpeningBalance: null };
    }

    const startBalance = data.bankAccounts.reduce(
      (sum, ba) => sum + (ba.openingBalance ?? 0),
      0,
    );
    let running = startBalance;
    const balances = new Map<string, number>();

    for (const day of data.days) {
      for (const entry of day.entries) {
        running += entry.amount;
      }
      balances.set(day.date, Math.round(running * 100) / 100);
    }

    return {
      dayBalances: balances,
      endBalance: Math.round(running * 100) / 100,
      totalOpeningBalance: Math.round(startBalance * 100) / 100,
    };
  }, [data]);

  // Map bank account id → name for labeling transactions.
  const bankAccountNames = useMemo(() => {
    const map = new Map<string, string>();
    if (data?.bankAccounts) {
      for (const ba of data.bankAccounts) {
        map.set(ba.id, ba.name ?? 'Conta');
      }
    }
    return map;
  }, [data]);

  // ── Manual entry form ──
  const [showForm, setShowForm] = useState(false);

  const createMut = useMutation({
    mutationFn: api.createManualEntry,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cashflow'] });
      setShowForm(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: api.deleteManualEntry,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });

  const descMut = useMutation({
    mutationFn: ({ id, desc }: { id: string; desc: string }) =>
      api.updateTransactionDescription(id, desc),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });

  const loading = cashflowQ.isLoading;
  const hasMultipleBanks = (data?.bankAccounts?.length ?? 0) > 1;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="eyebrow mb-6 inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-accent)]"
      >
        ← voltar
      </button>

      {/* Header */}
      <div className="mb-10">
        <div className="eyebrow uppercase">fluxo de caixa</div>

        <div className="mt-3 font-display text-[72px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[96px]">
          {loading ? (
            <span className="inline-block h-[72px] w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)] md:h-[96px]" />
          ) : (
            monthLabel(year, month)
          )}
        </div>

        {/* Bank accounts summary */}
        {data?.bankAccounts && data.bankAccounts.length > 0 && (
          <div className="mt-4 space-y-1">
            {data.bankAccounts.map((ba) => (
              <div key={ba.id} className="flex items-center gap-2 font-body text-sm text-[color:var(--color-ink-muted)]">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: bankColorMap.get(ba.id) }}
                />
                <span className="font-mono text-base text-[color:var(--color-ink)]">
                  {formatBRL(ba.openingBalance ?? 0)}
                </span>
                <span>
                  saldo início do mês · {ba.name ?? 'Conta corrente'}
                </span>
              </div>
            ))}
            {data.bankAccounts.length > 1 && totalOpeningBalance !== null && (
              <div className="flex items-baseline gap-2 pl-4 pt-1 font-body text-sm text-[color:var(--color-ink-muted)]">
                <span className="font-mono text-base font-semibold text-[color:var(--color-ink)]">
                  {formatBRL(totalOpeningBalance)}
                </span>
                <span>total consolidado</span>
              </div>
            )}
          </div>
        )}

        {data?.bankAccounts?.length === 0 && !loading && (
          <p className="mt-4 font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma conta corrente sincronizada. Execute o sync para buscar contas BANK do Pluggy.
          </p>
        )}
      </div>

      {/* Column headers */}
      {!loading && data && data.days.length > 0 && (
        <div className="rule-bottom flex items-baseline pb-2">
          <span className="w-[80px] shrink-0 font-body text-[10px] uppercase tracking-wider text-[color:var(--color-ink-faint)]">
            dia
          </span>
          <span className="flex-1 font-body text-[10px] uppercase tracking-wider text-[color:var(--color-positive)]">
            entradas
          </span>
          <span className="flex-1 font-body text-[10px] uppercase tracking-wider text-[color:var(--color-ink-muted)]">
            saídas
          </span>
          <span className="w-[100px] shrink-0 text-right font-body text-[10px] uppercase tracking-wider text-[color:var(--color-ink-faint)]">
            saldo
          </span>
        </div>
      )}

      {/* Day-by-day timeline */}
      {loading ? (
        <TimelineSkeleton />
      ) : data && data.days.length > 0 ? (
        <div className="space-y-0">
          {data.days.map((day) => (
            <DaySection
              key={day.date}
              day={day}
              today={today}
              runningBalance={dayBalances.get(day.date) ?? null}
              bankAccountNames={hasMultipleBanks ? bankAccountNames : null}
              bankColorMap={bankColorMap}
              onDeleteManual={(id) => deleteMut.mutate(id)}
              onEditDescription={(txId, desc) =>
                descMut.mutate({ id: txId, desc })
              }
            />
          ))}
        </div>
      ) : (
        !loading && (
          <p className="font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma movimentação neste mês.
          </p>
        )
      )}

      {/* Projected end-of-month balance */}
      {endBalance !== null && (
        <div className="rule-top mt-8 pt-6">
          <span className="font-body text-sm text-[color:var(--color-ink-muted)]">
            Saldo projetado fim do mês
          </span>
          <div className="mt-1 font-mono text-2xl text-[color:var(--color-ink)]">
            {formatBRL(endBalance)}
          </div>
        </div>
      )}

      {/* Add manual entry */}
      <div className="mt-8">
        {showForm ? (
          <ManualEntryForm
            onSubmit={(entry) => createMut.mutate(entry)}
            onCancel={() => setShowForm(false)}
            submitting={createMut.isPending}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="font-body text-sm text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)]"
          >
            + adicionar entrada mensal
          </button>
        )}
      </div>
    </motion.section>
  );
}

// ── Day Section ──

function DaySection({
  day,
  today,
  runningBalance,
  bankAccountNames,
  bankColorMap,
  onDeleteManual,
  onEditDescription,
}: {
  day: CashFlowDay;
  today: string;
  runningBalance: number | null;
  bankAccountNames: Map<string, string> | null;
  bankColorMap: Map<string, string>;
  onDeleteManual: (id: number) => void;
  onEditDescription: (txId: string, desc: string) => void;
}) {
  const isToday = day.date === today;

  // Separate entries into income and expense columns.
  const income = day.entries.filter((e) => e.amount > 0);
  const expense = day.entries.filter((e) => e.amount <= 0);
  const maxRows = Math.max(income.length, expense.length);

  return (
    <div
      className={`rule-top py-3 ${
        day.isPast && !isToday
          ? 'bg-[color:var(--color-paper-tint)]'
          : isToday
            ? 'bg-[color:var(--color-paper-shadow)]/20'
            : ''
      }`}
    >
      {/* One row per max(income, expense) entry */}
      {Array.from({ length: maxRows }, (_, i) => {
        const inc = income[i] ?? null;
        const exp = expense[i] ?? null;
        return (
          <div key={i} className="flex items-center py-0.5">
            {/* Date column — only show on first row */}
            <div className="w-[80px] shrink-0">
              {i === 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs text-[color:var(--color-ink-muted)]">
                    {formatDateShort(day.date)}
                  </span>
                  {isToday && (
                    <span className="font-body text-[9px] uppercase tracking-wider text-[color:var(--color-accent)]">
                      hoje
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Income column */}
            <div className="flex-1 pr-2">
              {inc && (
                <EntryCell
                  entry={inc}
                  isPast={day.isPast}
                  bankAccountName={
                    bankAccountNames && inc.bankAccountId
                      ? bankAccountNames.get(inc.bankAccountId) ?? null
                      : null
                  }
                  bulletColor={
                    inc.bankAccountId
                      ? bankColorMap.get(inc.bankAccountId) ?? 'var(--color-positive)'
                      : inc.type === 'manual_entry'
                        ? 'var(--color-ink-faint)'
                        : 'var(--color-positive)'
                  }
                  amountColor="var(--color-positive)"
                  onDeleteManual={onDeleteManual}
                  onEditDescription={onEditDescription}
                />
              )}
            </div>

            {/* Expense column */}
            <div className="flex-1 pr-2">
              {exp && (
                <EntryCell
                  entry={exp}
                  isPast={day.isPast}
                  bankAccountName={
                    bankAccountNames && exp.bankAccountId
                      ? bankAccountNames.get(exp.bankAccountId) ?? null
                      : null
                  }
                  bulletColor={
                    exp.bankAccountId
                      ? bankColorMap.get(exp.bankAccountId) ?? 'var(--color-ink-muted)'
                      : exp.type === 'credit_card_bill'
                        ? 'var(--color-accent)'
                        : 'var(--color-ink-faint)'
                  }
                  amountColor="var(--color-ink)"
                  onDeleteManual={onDeleteManual}
                  onEditDescription={onEditDescription}
                />
              )}
            </div>

            {/* Running balance — only show on first row */}
            <div className="w-[100px] shrink-0 text-right">
              {i === 0 && runningBalance !== null && (
                <span className="font-mono text-xs text-[color:var(--color-ink-faint)]">
                  {formatBRL(runningBalance)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Entry Cell (single entry in a column) ──

function EntryCell({
  entry,
  isPast,
  bankAccountName,
  bulletColor,
  amountColor,
  onDeleteManual,
  onEditDescription,
}: {
  entry: CashFlowEntry;
  isPast: boolean;
  bankAccountName: string | null;
  bulletColor: string;
  amountColor: string;
  onDeleteManual: (id: number) => void;
  onEditDescription: (txId: string, desc: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const typeLabel =
    entry.type === 'bank_transaction'
      ? bankAccountName
      : entry.type === 'manual_entry'
        ? 'mensal'
        : 'fatura';

  const handleDescSubmit = () => {
    const val = inputRef.current?.value.trim();
    if (val && val !== entry.description) {
      onEditDescription(entry.id, val);
    }
    setEditing(false);
  };

  const manualId =
    entry.type === 'manual_entry'
      ? Number(entry.id.replace('manual-', ''))
      : null;

  return (
    <div className="group flex items-center gap-2">
      {/* Bullet with bank color */}
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: bulletColor }}
      />

      {/* Description */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={entry.description}
            className="min-w-0 flex-1 border-b border-[color:var(--color-ink-faint)] bg-transparent font-body text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            onBlur={handleDescSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleDescSubmit();
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className={`truncate font-body text-xs ${
              isPast && entry.type === 'bank_transaction'
                ? 'cursor-pointer text-[color:var(--color-ink)] hover:text-[color:var(--color-accent)]'
                : 'text-[color:var(--color-ink)]'
            }`}
            onClick={() => {
              if (isPast && entry.type === 'bank_transaction') setEditing(true);
            }}
            title={
              isPast && entry.type === 'bank_transaction'
                ? 'Clique para editar descrição'
                : undefined
            }
          >
            {entry.description}
          </span>
        )}

        {typeLabel && (
          <span className="shrink-0 font-body text-[9px] italic text-[color:var(--color-ink-faint)]">
            {typeLabel}
          </span>
        )}
      </div>

      {/* Amount */}
      <span
        className="shrink-0 font-mono text-xs tabular-nums"
        style={{ color: amountColor }}
      >
        {formatBRL(Math.abs(entry.amount))}
      </span>

      {/* Delete button for manual entries */}
      {manualId !== null && (
        <button
          type="button"
          onClick={() => onDeleteManual(manualId)}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 font-body text-xs text-[color:var(--color-ink-faint)] hover:text-[color:var(--color-accent)]"
          title="Remover entrada"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Manual Entry Form ──

function ManualEntryForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (entry: { description: string; amount: number; dayOfMonth: number }) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const descRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const description = descRef.current?.value.trim();
    const amount = Number(amountRef.current?.value);
    const dayOfMonth = Number(dayRef.current?.value);

    if (!description || isNaN(amount) || amount === 0 || dayOfMonth < 1 || dayOfMonth > 31) return;

    onSubmit({ description, amount, dayOfMonth });
  };

  return (
    <form onSubmit={handleSubmit} className="rule-top pt-6 space-y-4">
      <div className="eyebrow">nova entrada mensal</div>

      <div className="flex flex-wrap gap-3">
        <input
          ref={descRef}
          type="text"
          placeholder="Descrição (ex: Salário)"
          className="min-w-[180px] flex-1 border-b border-[color:var(--color-ink-faint)] bg-transparent py-1 font-body text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
          required
        />
        <input
          ref={amountRef}
          type="number"
          step="0.01"
          placeholder="Valor (+ receita, - despesa)"
          className="w-[200px] border-b border-[color:var(--color-ink-faint)] bg-transparent py-1 font-mono text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
          required
        />
        <input
          ref={dayRef}
          type="number"
          min={1}
          max={31}
          placeholder="Dia"
          className="w-[70px] border-b border-[color:var(--color-ink-faint)] bg-transparent py-1 font-mono text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
          required
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="font-body text-sm text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {submitting ? 'salvando…' : 'salvar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-sm text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-ink)]"
        >
          cancelar
        </button>
      </div>
    </form>
  );
}

// ── Skeleton ──

function TimelineSkeleton() {
  return (
    <div className="space-y-4 opacity-50">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="rule-top py-4">
          <div className="h-3 w-16 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div className="mt-3 h-3 w-3/4 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div className="mt-2 h-3 w-1/2 rounded-sm bg-[color:var(--color-paper-tint)]" />
        </div>
      ))}
    </div>
  );
}
