import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../lib/api';
import type { CashFlowEntry, CashFlowDay, CashFlowResponse } from '../lib/api';
import { formatBRL, formatDateShort } from '../lib/format';
import { RowActionsMenu } from '../components/RowActionsMenu';
import { useIsDemo } from '../lib/useIsDemo';

const isDraggable = (e: CashFlowEntry) =>
  e.type === 'bank_transaction' || e.type === 'manual_entry';

function manualIdFromEntry(id: string): number {
  return Number(id.replace('manual-', ''));
}

/**
 * Apply a reorder operation to a day list, returning a new days array.
 * activeId lands relative to overId: when dragging downward it goes just
 * *after* overId, when dragging upward just *before* it (mirroring dnd-kit's
 * arrayMove semantics — without the direction check, moving down by one slot
 * is a no-op because the hovered item just shifts up into the vacated spot).
 * overId may be the day sentinel `__day__:YYYY-MM-DD`, meaning "end of day".
 */
function applyReorder(
  days: CashFlowDay[],
  activeId: string,
  overId: string,
): { days: CashFlowDay[]; sourceDate: string; targetDate: string } | null {
  // Flat draggable order across all days — the basis for direction detection.
  const flat: Array<{ id: string; date: string }> = [];
  for (const d of days) {
    for (const e of d.entries) {
      if (isDraggable(e)) flat.push({ id: e.id, date: d.date });
    }
  }

  const activeIdx = flat.findIndex((f) => f.id === activeId);
  if (activeIdx === -1) return null;
  const sourceDate = flat[activeIdx].date;
  const activeEntry = days
    .flatMap((d) => d.entries)
    .find((e) => e.id === activeId)!;

  let targetDate: string;
  let overIdx: number;
  if (overId.startsWith('__day__:')) {
    targetDate = overId.slice('__day__:'.length);
    overIdx = flat.length; // dropping onto empty day space — treat as "after end"
  } else {
    overIdx = flat.findIndex((f) => f.id === overId);
    if (overIdx === -1) return null;
    targetDate = flat[overIdx].date;
  }

  const movingDown = activeIdx < overIdx;

  // Build new days with active removed from its source position.
  const newDays: CashFlowDay[] = days.map((d) => ({
    ...d,
    entries: d.entries.filter((e) => e.id !== activeId),
  }));

  const target = newDays.find((d) => d.date === targetDate);
  if (!target) return null;

  if (overId.startsWith('__day__:')) {
    target.entries.push(activeEntry);
  } else {
    const overPos = target.entries.findIndex((e) => e.id === overId);
    const insertAt =
      overPos === -1
        ? target.entries.length
        : movingDown
          ? overPos + 1
          : overPos;
    target.entries.splice(insertAt, 0, activeEntry);
  }

  return { days: newDays, sourceDate, targetDate };
}

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

  const PROJECTION_STORAGE_KEY = 'cashflow:projectionCount';
  const PROJECTION_MAX = 12;
  const [projectionCount, setProjectionCount] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const raw = window.localStorage.getItem(PROJECTION_STORAGE_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, PROJECTION_MAX) : 0;
  });
  useEffect(() => {
    window.localStorage.setItem(PROJECTION_STORAGE_KEY, String(projectionCount));
  }, [projectionCount]);

  const { historyMonths, projectionMonths, allVisibleMonths } = useMemo(() => {
    if (!rangeQ.data?.lastMonth) return { historyMonths: [], projectionMonths: [], allVisibleMonths: [] };
    const [ey, em] = rangeQ.data.lastMonth.split('-').map(Number);
    const current = { year: ey, month: em };

    const projections: Array<{ year: number; month: number }> = [];
    for (let i = 1; i <= projectionCount; i++) projections.push(addMonth(ey, em, i));

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
    visible.push(...projections);

    return {
      historyMonths: history,
      projectionMonths: projections,
      allVisibleMonths: visible,
    };
  }, [rangeQ.data, historyOpen, projectionCount]);

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
  const billTagMut = useMutation({
    mutationFn: ({ id, tagged }: { id: string; tagged: boolean }) =>
      tagged ? api.untagBillPayment(id) : api.tagBillPayment(id),
    onSuccess: invalidateAll,
  });
  const hideMut = useMutation({
    mutationFn: (id: string) => api.hideBankTransaction(id),
    onSuccess: invalidateAll,
  });
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

  // ── Drag-and-drop reorder ──
  // Rebuilds sort_keys for affected days, persists them, and applies an
  // optimistic update to the month's cache so the row moves instantly.
  const handleReorder = useCallback(
    (monthStr: string, activeId: string, overId: string) => {
      const cacheKey = ['cashflow', monthStr];
      const current = qc.getQueryData<CashFlowResponse>(cacheKey);
      if (!current) return;

      const result = applyReorder(current.days, activeId, overId);
      if (!result) return;
      const { days: newDays, sourceDate, targetDate } = result;

      // Locate the active entry to check kind for cross-day rejection.
      const activeEntry = current.days
        .flatMap((d) => d.entries)
        .find((e) => e.id === activeId);
      if (!activeEntry) return;

      if (
        activeEntry.type === 'bank_transaction' &&
        sourceDate !== targetDate
      ) {
        // Bank transactions cannot move between days.
        return;
      }

      // Optimistic update.
      qc.setQueryData<CashFlowResponse>(cacheKey, {
        ...current,
        days: newDays,
      });

      // Build persistence calls: for each affected day, write a fresh
      // sort_key (1000, 2000, …) for every draggable entry in display
      // order. The moved entry (when crossing days as a manual_entry)
      // also gets its day_of_month updated.
      const affected = new Set([sourceDate, targetDate]);
      const calls: Promise<unknown>[] = [];

      for (const day of newDays) {
        if (!affected.has(day.date)) continue;
        const draggable = day.entries.filter(isDraggable);
        draggable.forEach((e, i) => {
          const sortKey = (i + 1) * 1000;
          if (e.type === 'bank_transaction') {
            calls.push(api.setBankTransactionSortKey(e.id, sortKey));
          } else {
            const manualId = manualIdFromEntry(e.id);
            const crossing = e.id === activeId && sourceDate !== targetDate;
            const body: { sortKey: number; dayOfMonth?: number } = { sortKey };
            if (crossing) {
              body.dayOfMonth = Number(day.date.split('-')[2]);
            }
            calls.push(api.updateManualEntry(manualId, body));
          }
        });
      }

      Promise.allSettled(calls).then(() => {
        qc.invalidateQueries({ queryKey: ['cashflow'] });
      });
    },
    [qc],
  );

  // ── Sync ──
  const isDemo = useIsDemo();
  const [syncing, setSyncing] = useState(false);
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await api.syncCashFlow();
      qc.invalidateQueries({ queryKey: ['cashflow'] });
      qc.invalidateQueries({ queryKey: ['cashflow-range'] });
    } catch (err) {
      console.error('[CashFlow sync] failed:', err);
    } finally {
      setSyncing(false);
    }
  }, [qc]);

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
        <div className="flex items-center gap-4">
          <span className="eyebrow uppercase">fluxo de caixa</span>
          {!isDemo && (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
            >
              {syncing ? 'sincronizando…' : 'sincronizar ↻'}
            </button>
          )}
        </div>

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
            onToggleBillTag={(entry) =>
              billTagMut.mutate({ id: entry.id, tagged: !!entry.isBillPayment })
            }
            onCreateEntry={(e) => createMut.mutate({ ...e, month: ms })}
            onDuplicateEntry={(e) => createMut.mutate(e)}
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
            onHide={(entry) => hideMut.mutate(entry.id)}
            onReorder={(activeId, overId) => handleReorder(ms, activeId, overId)}
          />
        );
      })}

      {/* Projection controls */}
      {rangeQ.data?.lastMonth && (
        <div className="mb-8 flex items-center gap-4 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)]">
          <button
            type="button"
            onClick={() => setProjectionCount((n) => Math.min(n + 1, PROJECTION_MAX))}
            disabled={projectionCount >= PROJECTION_MAX}
            className="transition-colors hover:text-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[color:var(--color-ink-muted)]"
          >
            + projetar mês
          </button>
          {projectionCount > 0 && (
            <>
              <span className="text-[color:var(--color-ink-faint)]">·</span>
              <button
                type="button"
                onClick={() => setProjectionCount((n) => Math.max(n - 1, 0))}
                className="transition-colors hover:text-[color:var(--color-accent)]"
              >
                − remover último ({monthLabel(projectionMonths[projectionMonths.length - 1].year, projectionMonths[projectionMonths.length - 1].month)})
              </button>
            </>
          )}
        </div>
      )}

    </motion.section>
  );
}

// ── Month section ──

function MonthSection({
  year,
  month,
  monthStr: ms,
  data,
  loading,
  today,
  dayBalances,
  endBalance,
  bankColorMap,
  bankNames,
  onSelectBill,
  onDeleteManual,
  onToggleBillTag,
  onCreateEntry,
  onDuplicateEntry,
  creating,
  onEditDesc,
  onEditAmount,
  onEditDay,
  onHide,
  onReorder,
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
  onToggleBillTag: (entry: CashFlowEntry) => void;
  onCreateEntry: (e: { description: string; amount: number; dayOfMonth: number }) => void;
  onDuplicateEntry: (e: { description: string; amount: number; dayOfMonth: number; month: string }) => void;
  creating: boolean;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  onHide: (entry: CashFlowEntry) => void;
  onReorder: (activeId: string, overId: string) => void;
}) {
  const [addingEntry, setAddingEntry] = useState(false);
  const nextMs = (() => {
    const n = addMonth(year, month, 1);
    return `${n.year}-${pad(n.month)}`;
  })();

  // Sortable item IDs in display order — used by SortableContext so dnd-kit
  // can compute insertion points based on hover position.
  const sortableIds = useMemo(() => {
    if (!data) return [];
    const ids: string[] = [];
    for (const d of data.days) {
      for (const e of d.entries) {
        if (isDraggable(e)) ids.push(e.id);
      }
    }
    return ids;
  }, [data]);

  const sensors = useSensors(
    // 6px activation distance keeps text selection / clicks working.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };

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
        className="rule-bottom grid items-baseline gap-x-2 md:gap-x-6 pb-2"
        style={{ gridTemplateColumns: 'var(--cashflow-table)' }}
      >
        <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)] opacity-0 md:opacity-100">
          origem
        </span>
        <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
          dia
        </span>
        <span className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
          descrição
        </span>
        <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)] hidden md:inline">
          débito
        </span>
        <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)] hidden md:inline">
          crédito
        </span>
        <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)] inline md:hidden">
          movimentação
        </span>
        <span className="text-right font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
          saldo
        </span>
      </div>

      {loading ? (
        <LedgerSkeleton />
      ) : data && data.days.length > 0 ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {data.days.map((day, di) => (
              <DayGroup
                key={day.date}
                day={day}
                today={today}
                balance={dayBalances.get(day.date) ?? null}
                bankColors={bankColorMap}
                bankNames={bankNames}
                onSelectBill={() => onSelectBill(year, month)}
                onDeleteManual={onDeleteManual}
                onToggleBillTag={onToggleBillTag}
                onDuplicate={(entry, dom) => onDuplicateEntry({
                  description: entry.description,
                  amount: entry.amount,
                  dayOfMonth: dom,
                  month: ms,
                })}
                onDuplicateNext={(entry, dom) => onDuplicateEntry({
                  description: entry.description,
                  amount: entry.amount,
                  dayOfMonth: dom,
                  month: nextMs,
                })}
                onEditDesc={onEditDesc}
                onEditAmount={onEditAmount}
                onEditDay={onEditDay}
                onHide={onHide}
                staggerIndex={di}
              />
            ))}
          </SortableContext>
        </DndContext>
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
  onDuplicate,
  onDuplicateNext,
  onToggleBillTag,
  onEditDesc,
  onEditAmount,
  onEditDay,
  onHide,
  staggerIndex,
}: {
  day: CashFlowDay;
  today: string;
  balance: number | null;
  bankColors: Map<string, string>;
  bankNames: Map<string, string>;
  onSelectBill: () => void;
  onDeleteManual: (id: number) => void;
  onDuplicate: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onDuplicateNext: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onToggleBillTag: (entry: CashFlowEntry) => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  onHide: (entry: CashFlowEntry) => void;
  staggerIndex: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, delay: Math.min(staggerIndex * 0.03, 0.4) }}
      className="rule-top"
    >
      {day.entries.map((entry, i) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          index={i}
          day={day}
          today={today}
          bankColors={bankColors}
          bankNames={bankNames}
          balance={balance}
          isLast={i === day.entries.length - 1}
          onSelectBill={onSelectBill}
          onDeleteManual={onDeleteManual}
          onToggleBillTag={onToggleBillTag}
          onDuplicate={onDuplicate}
          onDuplicateNext={onDuplicateNext}
          onEditDesc={onEditDesc}
          onEditAmount={onEditAmount}
          onEditDay={onEditDay}
          onHide={onHide}
        />
      ))}
    </motion.div>
  );
}

// ── Entry row ──

function EntryRow({
  entry,
  index: i,
  day,
  today,
  bankColors,
  bankNames,
  balance,
  isLast,
  onSelectBill,
  onDeleteManual,
  onToggleBillTag,
  onDuplicate,
  onDuplicateNext,
  onEditDesc,
  onEditAmount,
  onEditDay,
  onHide,
}: {
  entry: CashFlowEntry;
  index: number;
  day: CashFlowDay;
  today: string;
  bankColors: Map<string, string>;
  bankNames: Map<string, string>;
  balance: number | null;
  isLast: boolean;
  onSelectBill: () => void;
  onDeleteManual: (id: number) => void;
  onToggleBillTag: (entry: CashFlowEntry) => void;
  onDuplicate: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onDuplicateNext: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  onHide: (entry: CashFlowEntry) => void;
}) {
  const draggable = isDraggable(entry);
  const sortable = useSortable({ id: entry.id, disabled: !draggable });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const isDebit = entry.amount < 0;
  const manualId = entry.type === 'manual_entry' ? manualIdFromEntry(entry.id) : null;
  const dayOfMonth = Number(day.date.split('-')[2]);
  const isToday = day.date === today;

  const isBill = entry.isBillPayment || entry.type === 'credit_card_bill';
  const bulletColor = isBill
    ? 'var(--color-accent)'
    : entry.bankAccountId
      ? bankColors.get(entry.bankAccountId) ?? 'var(--color-ink-muted)'
      : 'var(--color-ink-faint)';

  const canToggleBillTag = day.isPast && entry.type === 'bank_transaction';

  return (
    <div
      ref={setNodeRef}
      style={{
        gridTemplateColumns: 'var(--cashflow-table)',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        position: 'relative',
      }}
      className={`group grid items-center gap-x-2 md:gap-x-6 py-[7px] ${day.isPast ? 'bg-[color:var(--color-paper-tint)]' : ''}`}
    >
      {draggable && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Reordenar"
          title="Arrastar para reordenar"
          className="absolute -left-5 top-1/2 -translate-y-1/2 cursor-grab select-none font-mono text-[12px] leading-none text-[color:var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[color:var(--color-accent)] group-hover:opacity-100 active:cursor-grabbing"
        >
          ⋮⋮
        </button>
      )}
      <RowBody
        entry={entry}
        i={i}
        day={day}
        isToday={isToday}
        manualId={manualId}
        bankNames={bankNames}
        bulletColor={bulletColor}
        isBill={isBill}
        canToggleBillTag={canToggleBillTag}
        isDebit={isDebit}
        balance={balance}
        isLast={isLast}
        dayOfMonth={dayOfMonth}
        onSelectBill={onSelectBill}
        onDeleteManual={onDeleteManual}
        onToggleBillTag={onToggleBillTag}
        onDuplicate={onDuplicate}
        onDuplicateNext={onDuplicateNext}
        onEditDesc={onEditDesc}
        onEditAmount={onEditAmount}
        onEditDay={onEditDay}
        onHide={onHide}
      />
    </div>
  );
}

function RowBody({
  entry,
  i,
  day,
  isToday,
  manualId,
  bankNames,
  bulletColor,
  isBill,
  canToggleBillTag,
  isDebit,
  balance,
  isLast,
  dayOfMonth,
  onSelectBill,
  onDeleteManual,
  onToggleBillTag,
  onDuplicate,
  onDuplicateNext,
  onEditDesc,
  onEditAmount,
  onEditDay,
  onHide,
}: {
  entry: CashFlowEntry;
  i: number;
  day: CashFlowDay;
  isToday: boolean;
  manualId: number | null;
  bankNames: Map<string, string>;
  bulletColor: string;
  isBill: boolean;
  canToggleBillTag: boolean;
  isDebit: boolean;
  balance: number | null;
  isLast: boolean;
  dayOfMonth: number;
  onSelectBill: () => void;
  onDeleteManual: (id: number) => void;
  onToggleBillTag: (entry: CashFlowEntry) => void;
  onDuplicate: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onDuplicateNext: (entry: CashFlowEntry, dayOfMonth: number) => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onEditAmount: (entry: CashFlowEntry, amount: number) => void;
  onEditDay: (entry: CashFlowEntry, day: number) => void;
  onHide: (entry: CashFlowEntry) => void;
}) {
  return (
    <>
      {/* Source / bank column */}
            {entry.type === 'manual_entry' ? <span /> : (
              <div
                className={`flex items-center gap-1.5 min-w-0 ${
                  canToggleBillTag || entry.type === 'credit_card_bill'
                    ? 'cursor-pointer hover:text-[color:var(--color-accent)]'
                    : ''
                }`}
                onClick={() => {
                  if (canToggleBillTag) onToggleBillTag(entry);
                  else if (entry.type === 'credit_card_bill') onSelectBill();
                }}
                title={
                  canToggleBillTag
                    ? (entry.isBillPayment ? 'Desmarcar como fatura' : 'Marcar como fatura')
                    : entry.type === 'credit_card_bill'
                      ? 'Ver detalhes da fatura'
                      : undefined
                }
              >
                <span
                  className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ backgroundColor: bulletColor }}
                />
                <span className={`truncate font-body text-[10px] ${isBill ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-ink-faint)]'}`}>
                  {isBill
                    ? 'fatura'
                    : entry.type === 'bank_transaction' && entry.bankAccountId
                      ? (bankNames?.get(entry.bankAccountId) ?? '')
                      : ''}
                </span>
              </div>
            )}

            {/* Date */}
            <div className={`flex items-center gap-1 ${i > 0 && entry.type === 'manual_entry' ? 'group-hover:opacity-100 transition-opacity' : ''}`}>
              {i === 0 || entry.type === 'manual_entry' ? (
                <>
                  <DayCell
                    index = {i}
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
              onDuplicate={() => onDuplicate(entry, dayOfMonth)}
              onDuplicateNext={() => onDuplicateNext(entry, dayOfMonth)}
              onHide={entry.type === 'bank_transaction' ? () => onHide(entry) : undefined}
            />
  
            {/* Debit column */}
            <AmountCell
              classname='hidden md:inline'
              amount={isDebit ? entry.amount : null}
              color="var(--color-ink)"
              editable={entry.type === 'manual_entry'}
              onSubmit={(val) => onEditAmount(entry, val)}
            />

            {/* Credit column */}
            <AmountCell
              classname='hidden md:inline'
              amount={!isDebit ? entry.amount : null}
              color="var(--color-positive)"
              editable={entry.type === 'manual_entry'}
              onSubmit={(val) => onEditAmount(entry, val)}
            />

            {/* Mobile amount column */}
            <AmountCell
              classname="inline md:hidden"
              amount={entry.amount} // placeholder to keep the cell width consistent
              color={isDebit ? "var(--color-ink)" : "var(--color-positive)"}
              editable={entry.type === 'manual_entry'}
              onSubmit={(val) => onEditAmount(entry, val)}
            />

            {/* Running balance — only on last row of the group */}
            <div className="text-right font-mono text-[11px] tabular-nums text-[color:var(--color-ink-muted)]">
              {isLast && balance !== null ? formatBRL(balance) : ''}
            </div>
    </>
  );
}

// ── Description cell ──

function DescriptionCell({
  entry,
  manualId,
  onSelectBill,
  onEditDesc,
  onDeleteManual,
  onDuplicate,
  onDuplicateNext,
  onHide,
}: {
  entry: CashFlowEntry;
  manualId: number | null;
  onSelectBill?: () => void;
  onEditDesc: (entry: CashFlowEntry, desc: string) => void;
  onDeleteManual: (id: number) => void;
  onDuplicate: () => void;
  onDuplicateNext: () => void;
  onHide?: () => void;
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
        <div className="ml-auto shrink-0">
          <RowActionsMenu
            ariaLabel="Ações da entrada"
            actions={[
              { label: 'Duplicar neste mês', onClick: onDuplicate },
              { label: 'Duplicar no próximo mês', onClick: onDuplicateNext },
              {
                label: 'Remover',
                onClick: () => onDeleteManual(manualId),
                tone: 'danger',
              },
            ]}
          />
        </div>
      )}

      {onHide && manualId === null && (
        <div className="ml-auto shrink-0">
          <RowActionsMenu
            ariaLabel="Ações da linha"
            actions={[
              { label: 'Esconder do fluxo de caixa', onClick: onHide },
            ]}
          />
        </div>
      )}
    </div>
  );
}

// ── Day cell ──

function DayCell({
  index,
  date,
  editable,
  onSubmit,
}: {
  index: number;
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
      className={`font-mono text-[11px] text-[color:var(--color-ink-muted)]
        ${editable ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}
        ${index ? 'opacity-0' : ''}`}
      onClick={() => { if (editable) setEditing(true); }}
      title={editable ? 'Editar dia' : undefined}
    >
      {formatDateShort(date)}
    </span>
  );
}

// ── Amount cell ──

function AmountCell({
  classname,
  amount,
  color,
  editable,
  onSubmit,
}: {
  classname?: string;
  amount: number | null;
  color: string;
  editable: boolean;
  onSubmit: (val: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (amount === null) return <div className={classname} />;

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
      className={`${classname} text-right font-mono text-[13px] tabular-nums ${editable ? 'cursor-pointer hover:text-[color:var(--color-accent)]' : ''}`}
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
        style={{ gridTemplateColumns: 'var(--cashflow-table)' }}
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
      style={{ gridTemplateColumns: 'var(--cashflow-table)' }}
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
          style={{ gridTemplateColumns: 'var(--cashflow-table)' }}
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
