import { useState, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import type { CashFlowEntry, CashFlowDay } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';

// ── Helpers ──

const MONTH_FMT = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
});

function monthLabel(year: number, month: number): string {
  return MONTH_FMT.format(new Date(year, month - 1, 1));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Stable muted colors for bank account identification.
 * Chosen to sit well on warm paper without competing with the accent.
 */
const BANK_COLORS = [
  '#5b7fa6', // slate blue
  '#8b6fa6', // muted violet
  '#5b9e8f', // sage
  '#b08d57', // aged gold
  '#a0756a', // clay
];

// ── Main Component ──

export function CashFlow({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();

  const cashflowQ = useQuery({
    queryKey: ['cashflow'],
    queryFn: api.getCashFlow,
  });

  const today = todayYmd();
  const data = cashflowQ.data;

  const [year, month] = data
    ? data.month.split('-').map(Number)
    : [new Date().getFullYear(), new Date().getMonth() + 1];

  // ── Bank colors ──
  const bankColorMap = useMemo(() => {
    const map = new Map<string, string>();
    data?.bankAccounts?.forEach((ba, i) => {
      map.set(ba.id, BANK_COLORS[i % BANK_COLORS.length]);
    });
    return map;
  }, [data]);

  // ── Running balance ──
  const { dayBalances, endBalance, totalOpeningBalance } = useMemo(() => {
    if (!data?.bankAccounts?.length) {
      return { dayBalances: new Map<string, number>(), endBalance: null, totalOpeningBalance: null };
    }
    const start = data.bankAccounts.reduce((s, ba) => s + (ba.openingBalance ?? 0), 0);
    let running = start;
    const balances = new Map<string, number>();
    for (const day of data.days) {
      for (const e of day.entries) running += e.amount;
      balances.set(day.date, Math.round(running * 100) / 100);
    }
    return {
      dayBalances: balances,
      endBalance: Math.round(running * 100) / 100,
      totalOpeningBalance: Math.round(start * 100) / 100,
    };
  }, [data]);

  const bankNames = useMemo(() => {
    const map = new Map<string, string>();
    data?.bankAccounts?.forEach((ba) => map.set(ba.id, ba.name ?? 'Conta'));
    return map;
  }, [data]);

  // ── Mutations ──
  const [showForm, setShowForm] = useState(false);

  const createMut = useMutation({
    mutationFn: api.createManualEntry,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cashflow'] }); setShowForm(false); },
  });
  const deleteMut = useMutation({
    mutationFn: api.deleteManualEntry,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });
  const descTxMut = useMutation({
    mutationFn: ({ id, desc }: { id: string; desc: string }) =>
      api.updateTransactionDescription(id, desc),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });
  const descManualMut = useMutation({
    mutationFn: ({ id, desc }: { id: number; desc: string }) =>
      api.updateManualEntry(id, { description: desc }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });
  const amountManualMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) =>
      api.updateManualEntry(id, { amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });
  const dayManualMut = useMutation({
    mutationFn: ({ id, dayOfMonth }: { id: number; dayOfMonth: number }) =>
      api.updateManualEntry(id, { dayOfMonth }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cashflow'] }),
  });

  const loading = cashflowQ.isLoading;
  const multiBanks = (data?.bankAccounts?.length ?? 0) > 1;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Navigation */}
      <button
        type="button"
        onClick={onBack}
        className="eyebrow mb-6 inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-accent)]"
      >
        ← voltar
      </button>

      {/* Masthead */}
      <div className="mb-12">
        <div className="eyebrow uppercase">fluxo de caixa</div>

        <h1 className="mt-3 font-display text-[72px] leading-[0.9] tracking-[-0.03em] text-[color:var(--color-ink)] md:text-[96px]">
          {loading ? (
            <span className="inline-block h-[72px] w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)] md:h-[96px]" />
          ) : (
            monthLabel(year, month)
          )}
        </h1>

        {/* Bank positions */}
        {data?.bankAccounts && data.bankAccounts.length > 0 && (
          <div className="mt-6 space-y-2">
            {data.bankAccounts.map((ba) => (
              <div key={ba.id} className="flex items-baseline gap-3">
                <span
                  className="mt-[3px] inline-block h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ backgroundColor: bankColorMap.get(ba.id) }}
                />
                <span className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)]">
                  {ba.name ?? 'Conta corrente'}
                </span>
                <span className="font-mono text-sm text-[color:var(--color-ink)]">
                  {formatBRL(ba.openingBalance ?? 0)}
                </span>
              </div>
            ))}
            {multiBanks && totalOpeningBalance !== null && (
              <div className="flex items-baseline gap-3 pt-1">
                <span className="inline-block h-[6px] w-[6px] shrink-0" />
                <span className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)]">
                  Consolidado
                </span>
                <span className="font-mono text-sm font-medium text-[color:var(--color-ink)]">
                  {formatBRL(totalOpeningBalance)}
                </span>
              </div>
            )}
          </div>
        )}

        {data?.bankAccounts?.length === 0 && !loading && (
          <p className="mt-6 font-body text-sm text-[color:var(--color-ink-faint)]">
            Nenhuma conta corrente sincronizada.
          </p>
        )}
      </div>

      {/* ── Ledger ── */}
      {loading ? (
        <LedgerSkeleton />
      ) : data && data.days.length > 0 ? (
        <>
          {/* Column headers */}
          <div
            className="rule-bottom grid items-baseline gap-x-6 pb-2"
            style={{ gridTemplateColumns: '64px 80px 1fr 110px 110px 120px' }}
          >
            <span />
            <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
              origem
            </span>
            <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
              descrição
            </span>
            <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
              débito
            </span>
            <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
              crédito
            </span>
            <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
              saldo
            </span>
          </div>

          {/* Day groups */}
          {data.days.map((day, di) => (
            <DayGroup
              key={day.date}
              day={day}
              today={today}
              balance={dayBalances.get(day.date) ?? null}
              bankColors={bankColorMap}
              bankNames={bankNames}
              onDeleteManual={(id) => deleteMut.mutate(id)}
              onEditDesc={(entry, desc) => {
                if (entry.type === 'manual_entry') {
                  const numId = Number(entry.id.replace('manual-', ''));
                  descManualMut.mutate({ id: numId, desc });
                } else if (entry.type === 'bank_transaction') {
                  descTxMut.mutate({ id: entry.id, desc });
                }
              }}
              onEditAmount={(entry, amount) => {
                if (entry.type === 'manual_entry') {
                  const numId = Number(entry.id.replace('manual-', ''));
                  amountManualMut.mutate({ id: numId, amount });
                }
              }}
              onEditDay={(entry, dayOfMonth) => {
                if (entry.type === 'manual_entry') {
                  const numId = Number(entry.id.replace('manual-', ''));
                  dayManualMut.mutate({ id: numId, dayOfMonth });
                }
              }}
              staggerIndex={di}
            />
          ))}

          {/* End-of-month projected balance */}
          {endBalance !== null && (
            <div
              className="grid items-baseline gap-x-6 border-t-2 border-[color:var(--color-ink)] py-3"
              style={{ gridTemplateColumns: '64px 80px 1fr 110px 110px 120px' }}
            >
              <span />
              <span />
              <span className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)]">
                Saldo projetado fim do mês
              </span>
              <span />
              <span />
              <span className="text-right font-mono text-sm font-medium text-[color:var(--color-ink)]">
                {formatBRL(endBalance)}
              </span>
            </div>
          )}
        </>
      ) : !loading && (
        <p className="font-body text-sm text-[color:var(--color-ink-faint)]">
          Nenhuma movimentação neste mês.
        </p>
      )}

      {/* Add manual entry */}
      <div className="mt-10">
        {showForm ? (
          <EntryForm
            onSubmit={(e) => createMut.mutate(e)}
            onCancel={() => setShowForm(false)}
            submitting={createMut.isPending}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)]"
          >
            + adicionar entrada mensal
          </button>
        )}
      </div>
    </motion.section>
  );
}

// ── Day group ──

function DayGroup({
  day,
  today,
  balance,
  bankColors,
  bankNames,
  onDeleteManual,
  onEditDesc,
  onEditAmount,
  onEditDay,
  staggerIndex,
}: {
  day: CashFlowDay;
  today: string;
  balance: number | null;
  bankColors: Map<string, string>;
  bankNames: Map<string, string>;
  onDeleteManual: (id: number) => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  staggerIndex: number;
}) {
  const isToday = day.date === today;
  const isFuture = !day.isPast && !isToday;

  // All entries in this day group that are manual (for date editing).
  const hasManualOnly = day.entries.length > 0 && day.entries.every((e) => e.type === 'manual_entry');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, delay: Math.min(staggerIndex * 0.03, 0.4) }}
      className="rule-top"
    >
      {day.entries.map((entry, i) => {
        const isDebit = entry.amount < 0;
        const manualId = entry.type === 'manual_entry'
          ? Number(entry.id.replace('manual-', ''))
          : null;

        const bulletColor = entry.bankAccountId
          ? bankColors.get(entry.bankAccountId) ?? 'var(--color-ink-muted)'
          : entry.type === 'credit_card_bill'
            ? 'var(--color-accent)'
            : 'var(--color-ink-faint)';

        return (
          <div
            key={entry.id}
            className={`group grid items-center gap-x-6 py-[7px] ${day.isPast ? 'bg-[color:var(--color-paper-tint)]' : ''}`}
            style={{
              gridTemplateColumns: '64px 80px 1fr 110px 110px 120px',
            }}
          >
            {/* Date — only on first row of the group */}
            <div className="flex items-center gap-1">
              {i === 0 ? (
                <>
                  <DayCell
                    date={day.date}
                    editable={hasManualOnly && entry.type === 'manual_entry'}
                    onSubmit={(d) => onEditDay(entry, d)}
                  />
                  {isToday && (
                    <span
                      className="inline-block h-[5px] w-[5px] rounded-full"
                      style={{ backgroundColor: 'var(--color-accent)' }}
                    />
                  )}
                </>
              ) : <span />}
            </div>

            {/* Source / bank column */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
                style={{ backgroundColor: bulletColor }}
              />
              <span className="truncate font-body text-[10px] text-[color:var(--color-ink-faint)]">
                {entry.type === 'bank_transaction' && entry.bankAccountId
                  ? (bankNames?.get(entry.bankAccountId) ?? '')
                  : entry.type === 'credit_card_bill'
                    ? 'fatura'
                    : entry.type === 'manual_entry'
                      ? 'mensal'
                      : ''}
              </span>
            </div>

            {/* Description */}
            <DescriptionCell
              entry={entry}
              manualId={manualId}
              onEditDesc={onEditDesc}
              onDeleteManual={onDeleteManual}
            />

            {/* Debit column */}
            <AmountCell
              amount={isDebit ? entry.amount : null}
              color="var(--color-ink)"
              editable={entry.type === 'manual_entry'}
              onSubmit={(val) => onEditAmount(entry, val)}
            />

            {/* Credit column */}
            <AmountCell
              amount={!isDebit ? entry.amount : null}
              color="var(--color-positive)"
              editable={entry.type === 'manual_entry'}
              onSubmit={(val) => onEditAmount(entry, val)}
            />

            {/* Running balance — only on last row of the group */}
            <div className="text-right font-mono text-[11px] tabular-nums text-[color:var(--color-ink-muted)]">
              {i === day.entries.length - 1 && balance !== null
                ? formatBRL(balance)
                : ''}
            </div>
          </div>
        );
      })}
    </motion.div>
  );
}

// ── Description cell ──

function DescriptionCell({
  entry,
  manualId,
  onEditDesc,
  onDeleteManual,
}: {
  entry: CashFlowEntry;
  manualId: number | null;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onDeleteManual: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const editable = entry.type === 'bank_transaction' || entry.type === 'manual_entry';

  const handleSubmit = () => {
    const val = inputRef.current?.value.trim();
    if (val && val !== entry.description) onEditDesc(entry, val);
    setEditing(false);
  };

  return (
    <div className="group/desc flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={entry.description}
          className="min-w-0 flex-1 border-b border-[color:var(--color-accent)] bg-transparent font-body text-[13px] text-[color:var(--color-ink)] outline-none"
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
            if (e.key === 'Escape') setEditing(false);
          }}
          autoFocus
        />
      ) : (
        <span
          className={`truncate font-body text-[13px] text-[color:var(--color-ink)] ${editable ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}`}
          onClick={() => { if (editable) setEditing(true); }}
          title={editable ? 'Editar descrição' : undefined}
        >
          {entry.description}
        </span>
      )}

      {/* Delete for manual entries */}
      {manualId !== null && (
        <button
          type="button"
          onClick={() => onDeleteManual(manualId)}
          className="ml-auto shrink-0 font-body text-[10px] text-[color:var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[color:var(--color-accent)] group-hover/desc:opacity-100"
        >
          remover
        </button>
      )}
    </div>
  );
}

// ── Day cell (click-to-edit day of month for manual entries) ──

function DayCell({
  date,
  editable,
  onSubmit,
}: {
  date: string;
  editable: boolean;
  onSubmit: (day: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentDay = Number(date.split('-')[2]);

  const handleSubmit = () => {
    const val = Number(inputRef.current?.value);
    if (val >= 1 && val <= 31 && val !== currentDay) onSubmit(val);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={1}
        max={31}
        defaultValue={currentDay}
        className="w-[36px] border-b border-[color:var(--color-accent)] bg-transparent font-mono text-[11px] text-[color:var(--color-ink)] outline-none"
        onBlur={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') setEditing(false);
        }}
        autoFocus
      />
    );
  }

  return (
    <span
      className={`font-mono text-[11px] text-[color:var(--color-ink-muted)] ${editable ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}`}
      onClick={() => { if (editable) setEditing(true); }}
      title={editable ? 'Editar dia' : undefined}
    >
      {formatDateShort(date)}
    </span>
  );
}

// ── Amount cell (click-to-edit for manual entries) ──

function AmountCell({
  amount,
  color,
  editable,
  onSubmit,
}: {
  amount: number | null;
  color: string;
  editable: boolean;
  onSubmit: (val: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (amount === null) return <div />;

  const handleSubmit = () => {
    const val = Number(inputRef.current?.value);
    if (!isNaN(val) && val !== 0 && val !== amount) onSubmit(val);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="text-right">
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          defaultValue={amount}
          className="w-full border-b border-[color:var(--color-accent)] bg-transparent text-right font-mono text-[13px] tabular-nums text-[color:var(--color-ink)] outline-none"
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
            if (e.key === 'Escape') setEditing(false);
          }}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div
      className={`text-right font-mono text-[13px] tabular-nums ${editable ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}`}
      style={{ color }}
      onClick={() => { if (editable) setEditing(true); }}
      title={editable ? 'Editar valor' : undefined}
    >
      {formatBRL(amount)}
    </div>
  );
}

// ── Manual entry form ──

function EntryForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (e: { description: string; amount: number; dayOfMonth: number }) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const descRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const description = descRef.current?.value.trim();
    const amount = Number(amountRef.current?.value);
    const dayOfMonth = Number(dayRef.current?.value);
    if (!description || isNaN(amount) || amount === 0 || dayOfMonth < 1 || dayOfMonth > 31) return;
    onSubmit({ description, amount, dayOfMonth });
  };

  return (
    <form onSubmit={handle} className="rule-top pt-6 space-y-5">
      <div className="eyebrow">nova entrada mensal</div>

      <div className="flex flex-wrap items-end gap-5">
        <label className="flex flex-col gap-1">
          <span className="font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Descrição
          </span>
          <input
            ref={descRef}
            type="text"
            placeholder="Salário, aluguel…"
            className="w-[220px] border-b border-[color:var(--color-paper-rule)] bg-transparent py-1.5 font-body text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Valor
          </span>
          <input
            ref={amountRef}
            type="number"
            step="0.01"
            placeholder="+5000 ou −2200"
            className="w-[150px] border-b border-[color:var(--color-paper-rule)] bg-transparent py-1.5 font-mono text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Dia
          </span>
          <input
            ref={dayRef}
            type="number"
            min={1}
            max={31}
            placeholder="15"
            className="w-[60px] border-b border-[color:var(--color-paper-rule)] bg-transparent py-1.5 font-mono text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] outline-none focus:border-[color:var(--color-accent)]"
            required
          />
        </label>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {submitting ? 'salvando…' : 'salvar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-ink)]"
        >
          cancelar
        </button>
      </div>
    </form>
  );
}

// ── Skeleton ──

function LedgerSkeleton() {
  return (
    <div className="space-y-0 opacity-40">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="rule-top grid items-center gap-x-6 py-3"
          style={{ gridTemplateColumns: '64px 80px 1fr 110px 110px 120px' }}
        >
          <div className="h-3 w-10 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div className="h-3 rounded-sm bg-[color:var(--color-paper-tint)]" style={{ width: `${40 + i * 8}%` }} />
          <div className="ml-auto h-3 w-14 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div />
          <div className="ml-auto h-3 w-16 rounded-sm bg-[color:var(--color-paper-tint)]" />
        </div>
      ))}
    </div>
  );
}
