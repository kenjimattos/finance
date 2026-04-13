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

  // ── Running balance ──
  const { dayBalances, endBalance } = useMemo(() => {
    if (!data?.bankAccount?.balance) return { dayBalances: new Map<string, number>(), endBalance: null };

    const startBalance = data.bankAccount.balance;
    let running = startBalance;
    const balances = new Map<string, number>();

    for (const day of data.days) {
      for (const entry of day.entries) {
        running += entry.amount;
      }
      balances.set(day.date, Math.round(running * 100) / 100);
    }

    return { dayBalances: balances, endBalance: Math.round(running * 100) / 100 };
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

        {data?.bankAccount && (
          <div className="mt-4 font-body text-sm text-[color:var(--color-ink-muted)]">
            <span className="font-mono text-base text-[color:var(--color-ink)]">
              {formatBRL(data.bankAccount.balance ?? 0)}
            </span>
            {' '}
            <span>
              saldo atual · {data.bankAccount.name ?? 'Conta corrente'}
            </span>
          </div>
        )}

        {!data?.bankAccount && !loading && (
          <p className="mt-4 font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma conta corrente sincronizada. Execute o sync para buscar contas BANK do Pluggy.
          </p>
        )}
      </div>

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
  onDeleteManual,
  onEditDescription,
}: {
  day: CashFlowDay;
  today: string;
  runningBalance: number | null;
  onDeleteManual: (id: number) => void;
  onEditDescription: (txId: string, desc: string) => void;
}) {
  const isToday = day.date === today;

  return (
    <div
      className={`rule-top py-4 ${isToday ? 'bg-[color:var(--color-paper-tint)]' : ''}`}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[color:var(--color-ink-muted)]">
            {formatDateShort(day.date)}
          </span>
          {isToday && (
            <span className="font-body text-[10px] uppercase tracking-wider text-[color:var(--color-accent)]">
              hoje
            </span>
          )}
          {day.isPast && !isToday && (
            <span className="font-body text-[10px] uppercase tracking-wider text-[color:var(--color-ink-faint)]">
              realizado
            </span>
          )}
        </div>
        {runningBalance !== null && (
          <span className="font-mono text-xs text-[color:var(--color-ink-faint)]">
            {formatBRL(runningBalance)}
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1">
        {day.entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            isPast={day.isPast}
            onDeleteManual={onDeleteManual}
            onEditDescription={onEditDescription}
          />
        ))}
      </div>
    </div>
  );
}

// ── Entry Row ──

function EntryRow({
  entry,
  isPast,
  onDeleteManual,
  onEditDescription,
}: {
  entry: CashFlowEntry;
  isPast: boolean;
  onDeleteManual: (id: number) => void;
  onEditDescription: (txId: string, desc: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isIncome = entry.amount > 0;
  const typeLabel =
    entry.type === 'bank_transaction'
      ? null
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

  // Extract numeric id from "manual-123" for delete.
  const manualId =
    entry.type === 'manual_entry'
      ? Number(entry.id.replace('manual-', ''))
      : null;

  return (
    <div className="group flex items-center gap-3 py-0.5">
      {/* Type indicator */}
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor:
            entry.type === 'credit_card_bill'
              ? 'var(--color-accent)'
              : entry.type === 'manual_entry'
                ? 'var(--color-ink-faint)'
                : 'var(--color-ink-muted)',
        }}
      />

      {/* Description */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={entry.description}
            className="min-w-0 flex-1 border-b border-[color:var(--color-ink-faint)] bg-transparent font-body text-sm text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            onBlur={handleDescSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleDescSubmit();
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
          />
        ) : (
          <span
            className={`truncate font-body text-sm ${
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
          <span className="shrink-0 font-body text-[10px] italic text-[color:var(--color-ink-faint)]">
            {typeLabel}
          </span>
        )}
      </div>

      {/* Amount */}
      <span
        className="shrink-0 font-mono text-sm tabular-nums"
        style={{
          color: isIncome ? 'var(--color-positive)' : 'var(--color-ink)',
        }}
      >
        {isIncome ? '+' : ''}
        {formatBRL(entry.amount)}
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
