import { useState, useRef, useMemo } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';
import type { CashFlowEntry, CashFlowDay, CashFlowResponse } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';

// ── Helpers ──

const MONTH_FMT = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

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

function monthStr(y: number, m: number): string {
  return `${y}-${pad(m)}`;
}

function addMonth(y: number, m: number, delta: number): { year: number; month: number } {
  const zb = m - 1 + delta;
  return { year: y + Math.floor(zb / 12), month: ((zb % 12) + 12) % 12 + 1 };
}

/** Generate array of {year, month} from start to end (inclusive). */
function monthRange(
  startY: number, startM: number,
  endY: number, endM: number,
): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = [];
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    result.push({ year: y, month: m });
    const next = addMonth(y, m, 1);
    y = next.year;
    m = next.month;
  }
  return result;
}

const BANK_COLORS = [
  '#5b7fa6', '#8b6fa6', '#5b9e8f', '#b08d57', '#a0756a',
];

const GRID_COLS = '80px 64px 1fr 110px 110px 120px';

// ── Main Component ──

export function CashFlow({
  onSelectBill,
  onBack,
}: {
  onSelectBill: (year: number, month: number) => void;
  onBack?: () => void;
}) {
  const qc = useQueryClient();
  const today = todayYmd();

  // Fetch the actual date range of BANK transactions from the backend.
  const rangeQ = useQuery({
    queryKey: ['cashflow-range'],
    queryFn: api.getCashFlowRange,
  });

  // Current month is always visible; up to 5 previous months are behind a toggle.
  const [historyOpen, setHistoryOpen] = useState(false);

  const [projectionOpen, setProjectionOpen] = useState(false);

  const { historyMonths, projectionMonth, allVisibleMonths } = useMemo(() => {
    if (!rangeQ.data?.lastMonth) return { historyMonths: [], projectionMonth: null, allVisibleMonths: [] };
    const [ey, em] = rangeQ.data.lastMonth.split('-').map(Number);
    const current = { year: ey, month: em };
    const projection = addMonth(ey, em, 1);

    // Up to 5 months before the current, capped by firstMonth.
    const history: Array<{ year: number; month: number }> = [];
    const first = rangeQ.data.firstMonth;
    if (first) {
      const [fy, fm] = first.split('-').map(Number);
      const sixBack = addMonth(ey, em, -5);
      const startY = sixBack.year > fy || (sixBack.year === fy && sixBack.month > fm) ? sixBack.year : fy;
      const startM = sixBack.year > fy || (sixBack.year === fy && sixBack.month > fm) ? sixBack.month : fm;
      const range = monthRange(startY, startM, ey, em);
      for (let i = 0; i < range.length - 1; i++) history.push(range[i]);
    }

    const visible = historyOpen ? [...history, current] : [current];
    if (projectionOpen) visible.push(projection);

    return {
      historyMonths: history,
      projectionMonth: projection,
      allVisibleMonths: visible,
    };
  }, [rangeQ.data, historyOpen, projectionOpen]);

  // Only fetch months that are visible — avoids 12 parallel requests on load.
  const queries = useQueries({
    queries: allVisibleMonths.map((m) => ({
      queryKey: ['cashflow', monthStr(m.year, m.month)],
      queryFn: () => api.getCashFlow(monthStr(m.year, m.month)),
    })),
  });

  // Bank colors (stable across months — use first loaded response).
  const bankColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of queries) {
      if (q.data?.bankAccounts) {
        q.data.bankAccounts.forEach((ba, i) => {
          if (!map.has(ba.id)) map.set(ba.id, BANK_COLORS[i % BANK_COLORS.length]);
        });
      }
    }
    return map;
  }, [queries]);

  const bankNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of queries) {
      q.data?.bankAccounts?.forEach((ba) => {
        if (!map.has(ba.id)) map.set(ba.id, ba.name ?? 'Conta');
      });
    }
    return map;
  }, [queries]);

  // ── Running balance across all months ──
  // Compute per-day balances across all months sequentially.
  const { dayBalances, monthEndBalances } = useMemo(() => {
    const balances = new Map<string, number>();
    const monthEnds = new Map<string, number>();

    // Find opening balance from the first month that has data.
    let running: number | null = null;
    for (const q of queries) {
      if (q.data?.bankAccounts?.length) {
        running = q.data.bankAccounts.reduce((s, ba) => s + (ba.openingBalance ?? 0), 0);
        break;
      }
    }
    if (running === null) return { dayBalances: balances, monthEndBalances: monthEnds };

    for (let mi = 0; mi < queries.length; mi++) {
      const data = queries[mi].data;
      if (!data) continue;
      for (const day of data.days) {
        for (const e of day.entries) running += e.amount;
        balances.set(day.date, Math.round(running * 100) / 100);
      }
      monthEnds.set(data.month, Math.round(running * 100) / 100);
    }

    return { dayBalances: balances, monthEndBalances: monthEnds };
  }, [queries]);

  // ── Mutations ──

  const invalidateAll = () => qc.invalidateQueries({ queryKey: ['cashflow'] });

  const createMut = useMutation({
    mutationFn: api.createManualEntry,
    onSuccess: invalidateAll,
  });
  const deleteMut = useMutation({ mutationFn: api.deleteManualEntry, onSuccess: invalidateAll });
  const descTxMut = useMutation({
    mutationFn: ({ id, desc }: { id: string; desc: string }) =>
      api.updateTransactionDescription(id, desc),
    onSuccess: invalidateAll,
  });
  const descManualMut = useMutation({
    mutationFn: ({ id, desc }: { id: number; desc: string }) =>
      api.updateManualEntry(id, { description: desc }),
    onSuccess: invalidateAll,
  });
  const amountManualMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) =>
      api.updateManualEntry(id, { amount }),
    onSuccess: invalidateAll,
  });
  const dayManualMut = useMutation({
    mutationFn: ({ id, dayOfMonth }: { id: number; dayOfMonth: number }) =>
      api.updateManualEntry(id, { dayOfMonth }),
    onSuccess: invalidateAll,
  });

  const anyLoading = rangeQ.isLoading || queries.some((q) => q.isLoading);
  const firstData = queries.find((q) => q.data)?.data;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-2"
    >
      {/* Masthead */}
      <div className="mb-12">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="eyebrow mb-6 inline-flex items-center gap-1 transition-colors hover:text-[color:var(--color-accent)]"
          >
            ← voltar
          </button>
        )}
        <div className="eyebrow uppercase">fluxo de caixa</div>

        <h1 className="mt-3 font-display text-[72px] leading-[0.9] tracking-[-0.03em] text-[color:var(--color-ink)] md:text-[96px]">
          {anyLoading && !firstData ? (
            <span className="inline-block h-[72px] w-2/3 animate-pulse rounded-sm bg-[color:var(--color-paper-tint)] md:h-[96px]" />
          ) : allVisibleMonths.length > 0 ? (
            allVisibleMonths.length === 1
              ? monthLabel(allVisibleMonths[0].year, allVisibleMonths[0].month)
              : `${monthLabel(allVisibleMonths[0].year, allVisibleMonths[0].month).split(' ')[0]} — ${monthLabel(allVisibleMonths[allVisibleMonths.length - 1].year, allVisibleMonths[allVisibleMonths.length - 1].month)}`
          ) : (
            'Fluxo de caixa'
          )}
        </h1>

        {/* Bank accounts legend */}
        {firstData?.bankAccounts && firstData.bankAccounts.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            {firstData.bankAccounts.map((ba) => (
              <div key={ba.id} className="flex items-center gap-2">
                <span
                  className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ backgroundColor: bankColorMap.get(ba.id) }}
                />
                <span className="font-body text-[12px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)]">
                  {ba.name ?? 'Conta corrente'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History toggle */}
      {historyMonths.length > 0 && (
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          className="mb-8 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {historyOpen
            ? '− ocultar histórico'
            : `+ mostrar ${historyMonths.length} ${historyMonths.length === 1 ? 'mês anterior' : 'meses anteriores'}`}
        </button>
      )}

      {/* ── Month sections ── */}
      {allVisibleMonths.map((m, mi) => {
        const q = queries[mi];
        const data = q?.data;
        const ms = monthStr(m.year, m.month);
        const endBal = monthEndBalances.get(ms) ?? null;

        return (
          <MonthSection
            key={ms}
            year={m.year}
            month={m.month}
            monthStr={ms}
            data={data ?? null}
            loading={q?.isLoading ?? false}
            today={today}
            dayBalances={dayBalances}
            endBalance={endBal}
            bankColorMap={bankColorMap}
            bankNames={bankNames}
            onSelectBill={onSelectBill}
            onDeleteManual={(id) => deleteMut.mutate(id)}
            onCreateEntry={(e) => createMut.mutate({ ...e, month: ms })}
            creating={createMut.isPending}
            onEditDesc={(entry, desc) => {
              if (entry.type === 'manual_entry') {
                descManualMut.mutate({ id: Number(entry.id.replace('manual-', '')), desc });
              } else if (entry.type === 'bank_transaction') {
                descTxMut.mutate({ id: entry.id, desc });
              }
            }}
            onEditAmount={(entry, amount) => {
              if (entry.type === 'manual_entry') {
                amountManualMut.mutate({ id: Number(entry.id.replace('manual-', '')), amount });
              }
            }}
            onEditDay={(entry, dayOfMonth) => {
              if (entry.type === 'manual_entry') {
                dayManualMut.mutate({ id: Number(entry.id.replace('manual-', '')), dayOfMonth });
              }
            }}
          />
        );
      })}

      {/* Projection toggle */}
      {projectionMonth && (
        <button
          type="button"
          onClick={() => setProjectionOpen((o) => !o)}
          className="mb-8 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
        >
          {projectionOpen
            ? '− ocultar projeção'
            : `+ projeção ${monthLabel(projectionMonth.year, projectionMonth.month)}`}
        </button>
      )}

    </motion.section>
  );
}

// ── Month section ──

function MonthSection({
  year,
  month,
  monthStr,
  data,
  loading,
  today,
  dayBalances,
  endBalance,
  bankColorMap,
  bankNames,
  onSelectBill,
  onDeleteManual,
  onCreateEntry,
  creating,
  onEditDesc,
  onEditAmount,
  onEditDay,
}: {
  year: number;
  month: number;
  monthStr: string;
  data: CashFlowResponse | null;
  loading: boolean;
  today: string;
  dayBalances: Map<string, number>;
  endBalance: number | null;
  bankColorMap: Map<string, string>;
  bankNames: Map<string, string>;
  onSelectBill: (year: number, month: number) => void;
  onDeleteManual: (id: number) => void;
  onCreateEntry: (e: { description: string; amount: number; dayOfMonth: number }) => void;
  creating: boolean;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
}) {
  const [addingEntry, setAddingEntry] = useState(false);
  return (
    <div className="mb-10">
      {/* Month header */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[28px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]">
          {monthLabel(year, month)}
        </h2>
        {endBalance !== null && (
          <span className="font-mono text-sm text-[color:var(--color-ink-muted)]">
            {formatBRL(endBalance)}
          </span>
        )}
      </div>

      {/* Column headers */}
      <div
        className="rule-bottom grid items-baseline gap-x-6 pb-2"
        style={{ gridTemplateColumns: GRID_COLS }}
      >
        <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
          origem
        </span>
        <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
          dia
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

      {loading ? (
        <LedgerSkeleton />
      ) : data && data.days.length > 0 ? (
        data.days.map((day, di) => (
          <DayGroup
            key={day.date}
            day={day}
            today={today}
            balance={dayBalances.get(day.date) ?? null}
            bankColors={bankColorMap}
            bankNames={bankNames}
            onSelectBill={() => onSelectBill(year, month)}
            onDeleteManual={onDeleteManual}
            onEditDesc={onEditDesc}
            onEditAmount={onEditAmount}
            onEditDay={onEditDay}
            staggerIndex={di}
          />
        ))
      ) : !loading && (
        <p className="py-4 font-body text-sm text-[color:var(--color-ink-faint)]">
          Nenhuma movimentação.
        </p>
      )}

      {/* Add entry — scoped to this month */}
      <NewEntryRow
        active={addingEntry}
        onActivate={() => setAddingEntry(true)}
        onSubmit={(e) => { onCreateEntry(e); setAddingEntry(false); }}
        onCancel={() => setAddingEntry(false)}
        submitting={creating}
      />
    </div>
  );
}

// ── Day group ──

function DayGroup({
  day,
  today,
  balance,
  bankColors,
  bankNames,
  onSelectBill,
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
  onSelectBill: () => void;
  onDeleteManual: (id: number) => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  staggerIndex: number;
}) {
  const isToday = day.date === today;

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
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            {/* Source / bank column */}
            {entry.type === 'manual_entry' ? <span /> : (
              <div
                className={`flex items-center gap-1.5 min-w-0 ${entry.type === 'credit_card_bill' ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}`}
                onClick={() => { if (entry.type === 'credit_card_bill') onSelectBill(); }}
                title={entry.type === 'credit_card_bill' ? 'Ver detalhes da fatura' : undefined}
              >
                <span
                  className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ backgroundColor: bulletColor }}
                />
                <span className="truncate font-body text-[10px] text-[color:var(--color-ink-faint)]">
                  {entry.type === 'bank_transaction' && entry.bankAccountId
                    ? (bankNames?.get(entry.bankAccountId) ?? '')
                    : entry.type === 'credit_card_bill'
                      ? 'fatura'
                      : ''}
                </span>
              </div>
            )}

            {/* Date */}
            <div className={`flex items-center gap-1 ${i > 0 && entry.type === 'manual_entry' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>
              {i === 0 || entry.type === 'manual_entry' ? (
                <>
                  <DayCell
                    date={day.date}
                    editable={entry.type === 'manual_entry'}
                    onSubmit={(d) => onEditDay(entry, d)}
                  />
                  {i === 0 && isToday && (
                    <span
                      className="inline-block h-[5px] w-[5px] rounded-full"
                      style={{ backgroundColor: 'var(--color-accent)' }}
                    />
                  )}
                </>
              ) : <span />}
            </div>

            {/* Description */}
            <DescriptionCell
              entry={entry}
              manualId={manualId}
              onSelectBill={entry.type === 'credit_card_bill' ? onSelectBill : undefined}
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
  onSelectBill,
  onEditDesc,
  onDeleteManual,
}: {
  entry: CashFlowEntry;
  manualId: number | null;
  onSelectBill?: () => void;
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
          className={`truncate font-body text-[13px] text-[color:var(--color-ink)] ${
            editable
              ? 'cursor-pointer hover:text-[color:var(--color-accent)]'
              : onSelectBill
                ? 'cursor-pointer hover:text-[color:var(--color-accent)]'
                : ''
          }`}
          onClick={() => {
            if (editable) setEditing(true);
            else if (onSelectBill) onSelectBill();
          }}
          title={
            editable
              ? 'Editar descrição'
              : onSelectBill
                ? 'Ver detalhes da fatura'
                : undefined
          }
        >
          {entry.description}
        </span>
      )}

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

// ── Day cell ──

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

// ── Amount cell ──

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

// ── New entry row ──

function NewEntryRow({
  active,
  onActivate,
  onSubmit,
  onCancel,
  submitting,
}: {
  active: boolean;
  onActivate: () => void;
  onSubmit: (e: { description: string; amount: number; dayOfMonth: number }) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const descRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const description = descRef.current?.value.trim();
    const amount = Number(amountRef.current?.value);
    const dayOfMonth = Number(dayRef.current?.value);
    if (!description || isNaN(amount) || amount === 0 || dayOfMonth < 1 || dayOfMonth > 31) return;
    onSubmit({ description, amount, dayOfMonth });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onCancel();
  };

  const inputClass = 'w-full bg-transparent outline-none border-b border-transparent focus:border-[color:var(--color-accent)]';

  if (!active) {
    return (
      <div
        className="rule-top grid items-center gap-x-6 py-[7px] opacity-0 transition-opacity hover:opacity-100 cursor-pointer"
        style={{ gridTemplateColumns: GRID_COLS }}
        onClick={onActivate}
      >
        <span />
        <span className="font-mono text-[11px] text-[color:var(--color-ink-faint)]">dia</span>
        <span className="font-body text-[13px] text-[color:var(--color-ink-faint)]">+ nova entrada</span>
        <span className="text-right font-mono text-[13px] text-[color:var(--color-ink-faint)]">valor</span>
        <span />
        <span />
      </div>
    );
  }

  return (
    <div
      className="rule-top grid items-center gap-x-6 py-[7px]"
      style={{ gridTemplateColumns: GRID_COLS }}
    >
      <span />
      <input
        ref={dayRef}
        type="number"
        min={1}
        max={31}
        placeholder="dia"
        className={`${inputClass} font-mono text-[11px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)]`}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <input
        ref={descRef}
        type="text"
        placeholder="Descrição"
        className={`${inputClass} font-body text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)]`}
        onKeyDown={handleKeyDown}
      />
      <input
        ref={amountRef}
        type="number"
        step="0.01"
        placeholder="valor"
        className={`${inputClass} text-right font-mono text-[13px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)]`}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="font-body text-[10px] uppercase tracking-[0.1em] text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {submitting ? '…' : 'salvar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-[10px] uppercase tracking-[0.1em] text-[color:var(--color-ink-faint)] hover:text-[color:var(--color-ink)]"
        >
          esc
        </button>
      </div>
      <span />
    </div>
  );
}

// ── Skeleton ──

function LedgerSkeleton() {
  return (
    <div className="space-y-0 opacity-40">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="rule-top grid items-center gap-x-6 py-3"
          style={{ gridTemplateColumns: GRID_COLS }}
        >
          <div className="h-3 w-10 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div className="h-3 w-8 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div className="h-3 rounded-sm bg-[color:var(--color-paper-tint)]" style={{ width: `${40 + i * 10}%` }} />
          <div className="ml-auto h-3 w-14 rounded-sm bg-[color:var(--color-paper-tint)]" />
          <div />
          <div className="ml-auto h-3 w-16 rounded-sm bg-[color:var(--color-paper-tint)]" />
        </div>
      ))}
    </div>
  );
}
