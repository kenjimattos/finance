/**
 * Bill window math.
 *
 * Pluggy does NOT expose the currently open bill — its /bills endpoint only
 * returns closed bills, and `billId` on transactions is only populated after
 * closing. So we reconstruct the open-bill window ourselves, from the user's
 * configured closing_day + due_day (captured once per account in account_settings).
 *
 * The rules we follow:
 *  - Each cycle is named by its *cycle month*: the month its closing_day
 *    falls in by default. Cycle M runs from the day after M−1's closing
 *    through M's closing.
 *  - The user can override the closing and/or due date of a single cycle
 *    (bill_cycle_overrides). Moving cycle M's closing moves only the boundary
 *    between M and M+1; every other cycle keeps its dates.
 *  - The open bill is the first cycle whose closing is today or later.
 *  - Without an override, the due date is due_day in the cycle month when
 *    due_day > closing_day, otherwise in the month after. A closing override
 *    does not move the due month.
 *
 * Everything is computed in the America/Sao_Paulo timezone intent, but we
 * use UTC-safe date math (treat dates as yyyy-mm-dd strings, no times) to
 * avoid DST gotchas.
 */

export interface CycleOverride {
  closingDate?: string | null; // yyyy-mm-dd
  dueDate?: string | null; // yyyy-mm-dd
}

export interface CardSettings {
  closingDay: number; // 1..28 — we clamp anything above to keep month math safe
  dueDay: number;
  /** Per-cycle overrides keyed by cycle month (`YYYY-MM`). */
  overrides?: ReadonlyMap<string, CycleOverride>;
}

export interface BillWindow {
  /** Inclusive start of the window (first day purchases land in this bill). */
  periodStart: string; // yyyy-mm-dd
  /** Inclusive end of the window (the closing day itself). */
  periodEnd: string;
  /** When this bill will close. */
  nextClosingDate: string;
  /** When this bill will be due for payment. */
  nextDueDate: string;
  /** `YYYY-MM` of the default closing — the key of bill_cycle_overrides. */
  cycleMonth: string;
  closingOverridden: boolean;
  dueOverridden: boolean;
}

function clampDay(day: number): number {
  // Using 1..28 avoids "Feb has no 31st" kind of edge cases in closing/due.
  // Brazilian cards realistically never use days 29–31 anyway.
  if (day < 1) return 1;
  if (day > 28) return 28;
  return Math.floor(day);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function ymd(year: number, month1: number, day: number): string {
  return `${year}-${pad(month1)}-${pad(day)}`;
}

function addMonths(year: number, month1: number, delta: number): { year: number; month1: number } {
  // month1 is 1..12
  const zeroBased = month1 - 1 + delta;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = ((zeroBased % 12) + 12) % 12;
  return { year: newYear, month1: newMonth + 1 };
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function cycleKey(year: number, month1: number): string {
  return `${year}-${pad(month1)}`;
}

/** The closing date of a cycle: its override, or closing_day in the cycle month. */
export function closingDateFor(settings: CardSettings, year: number, month1: number): string {
  return (
    settings.overrides?.get(cycleKey(year, month1))?.closingDate ??
    ymd(year, month1, clampDay(settings.closingDay))
  );
}

/** The window of the cycle whose default closing falls in year/month1. */
export function computeBillWindowForCycle(
  settings: CardSettings,
  year: number,
  month1: number,
): BillWindow {
  const prev = addMonths(year, month1, -1);
  const periodStart = addDays(closingDateFor(settings, prev.year, prev.month1), 1);
  const periodEnd = closingDateFor(settings, year, month1);

  const override = settings.overrides?.get(cycleKey(year, month1));

  // Due date: due_day in the cycle month when it comes after closing_day,
  // otherwise in the month after. Computed from the default days, so a
  // closing override never moves the due month.
  const dueDay = clampDay(settings.dueDay);
  const dueMonthOffset = dueDay > clampDay(settings.closingDay) ? 0 : 1;
  const dueMonth = addMonths(year, month1, dueMonthOffset);
  const nextDueDate = override?.dueDate ?? ymd(dueMonth.year, dueMonth.month1, dueDay);

  return {
    periodStart,
    periodEnd,
    nextClosingDate: periodEnd,
    nextDueDate,
    cycleMonth: cycleKey(year, month1),
    closingOverridden: !!override?.closingDate,
    dueOverridden: !!override?.dueDate,
  };
}

/** Cycle month of the currently open bill: the first cycle closing today or later. */
function openCycle(settings: CardSettings, today: Date): { year: number; month1: number } {
  const todayYmd = ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());
  // Start one month back: an override can push last month's closing past today.
  let c = addMonths(today.getFullYear(), today.getMonth() + 1, -1);
  while (closingDateFor(settings, c.year, c.month1) < todayYmd) {
    c = addMonths(c.year, c.month1, 1);
  }
  return c;
}

/** Offset (relative to the open bill) of the cycle named `YYYY-MM`. */
export function offsetOfCycle(
  settings: CardSettings,
  cycleMonth: string,
  today: Date = new Date(),
): number {
  const open = openCycle(settings, today);
  const [y, m] = cycleMonth.split('-').map(Number);
  return (y - open.year) * 12 + (m - open.month1);
}

/**
 * Compute a bill window shifted by `offset` cycles from the currently open bill.
 * offset =  0 → currently open bill (same as computeOpenBillWindow)
 * offset = -1 → the bill that just closed
 * offset = -N → N cycles in the past
 * offset = +1 → the next bill (useful for shift=-1 overrides)
 *
 * `today` defaults to the current date; pass it explicitly for deterministic tests.
 */
export function computeBillWindowAtOffset(
  settings: CardSettings,
  offset: number,
  today: Date = new Date(),
): BillWindow {
  const open = openCycle(settings, today);
  const c = addMonths(open.year, open.month1, offset);
  return computeBillWindowForCycle(settings, c.year, c.month1);
}

/**
 * Compute the currently open bill window for a given card.
 * `today` defaults to the current date; pass it explicitly for deterministic tests.
 */
export function computeOpenBillWindow(
  settings: CardSettings,
  today: Date = new Date(),
): BillWindow {
  return computeBillWindowAtOffset(settings, 0, today);
}

/**
 * Same idea but for the *previous* closed bill — useful for "vs last month"
 * comparisons. Returns the window that JUST closed.
 */
export function computePreviousBillWindow(
  settings: CardSettings,
  today: Date = new Date(),
): BillWindow {
  return computeBillWindowAtOffset(settings, -1, today);
}

/**
 * The *next* bill window — useful for manual bill-shift overrides, where a
 * transaction with shift=-1 belongs to the current cycle but its raw date
 * lands in the next cycle.
 */
export function computeNextBillWindow(
  settings: CardSettings,
  today: Date = new Date(),
): BillWindow {
  return computeBillWindowAtOffset(settings, 1, today);
}

/**
 * Find the bill offset whose window naturally contains a given date.
 *
 * "Natural" means: ignoring any per-transaction bill_shift override — purely
 * which closing→closing cycle the calendar date falls into. The import flow
 * uses this to auto-shift a transaction into the bill the user is viewing:
 * `shift = targetOffset - naturalOffset`. A 17/06 purchase whose natural cycle
 * is the next bill, dropped into the bill that closed 16/06, yields shift -1.
 *
 * Searches ±`bound` cycles around offset 0. Returns `null` if the date is
 * outside that range (caller can treat it as "too far to auto-place").
 */
export function findOffsetForDate(
  settings: CardSettings,
  isoDate: string,
  today: Date = new Date(),
  bound = 18,
): number | null {
  for (let offset = -bound; offset <= bound; offset++) {
    const w = computeBillWindowAtOffset(settings, offset, today);
    if (isoDate >= w.periodStart && isoDate <= w.periodEnd) return offset;
  }
  return null;
}

/**
 * Recompute a bill-shift override after a transaction's date changes.
 *
 * A shift is relative to the transaction's date: shift `s` on a row whose
 * natural cycle is N displays it on bill N+s. When a repost moves the date
 * (Pluggy replaces a pending installment's due-date placeholder with the real
 * posting date), the preserved `s` starts pointing at a different bill. This
 * computes the shift that keeps the row on the bill the user placed it on:
 *
 *   target = naturalCycle(oldDate) + oldShift
 *   newShift = target - naturalCycle(newDate)
 *
 * Returns the required shift (0 means "remove the override"), which may fall
 * outside the ±1 the UI supports — the caller decides how to handle that.
 * Returns `null` when either date is outside the searchable window bound,
 * meaning the shift can't be recomputed reliably.
 */
export function recomputeShiftForDateChange(
  settings: CardSettings,
  oldDate: string,
  newDate: string,
  oldShift: number,
  today: Date = new Date(),
): number | null {
  const oldNatural = findOffsetForDate(settings, oldDate, today);
  const newNatural = findOffsetForDate(settings, newDate, today);
  if (oldNatural === null || newNatural === null) return null;
  return oldNatural + oldShift - newNatural;
}

export type CycleOverrideInput = { closingDate: string | null; dueDate: string | null };

export type ResolvedCycleOverride =
  | { ok: true; closingDate: string | null; dueDate: string | null }
  | { ok: false; error: 'ClosingOutOfRange' | 'DueOutOfRange'; message: string };

/** How far after the closing a due date may fall. */
const MAX_DUE_AFTER_CLOSING_DAYS = 45;

/**
 * Validate an override for one cycle and normalize it for storage: a date
 * equal to the cycle's default becomes null, so only real exceptions are
 * stored and "both null" means "remove the override".
 *
 * The closing must stay strictly between the neighboring cycles' closings
 * (their overrides included), so cycles never overlap or swap order. The due
 * date must come after the effective closing, within 45 days.
 */
export function resolveCycleOverride(
  settings: CardSettings,
  year: number,
  month1: number,
  input: CycleOverrideInput,
): ResolvedCycleOverride {
  const defaults = computeBillWindowForCycle(
    { closingDay: settings.closingDay, dueDay: settings.dueDay },
    year,
    month1,
  );
  const closingDate = input.closingDate === defaults.periodEnd ? null : input.closingDate;
  const dueDate = input.dueDate === defaults.nextDueDate ? null : input.dueDate;

  const prev = addMonths(year, month1, -1);
  const next = addMonths(year, month1, 1);
  const prevClosing = closingDateFor(settings, prev.year, prev.month1);
  const nextClosing = closingDateFor(settings, next.year, next.month1);
  const closing = closingDate ?? defaults.periodEnd;
  if (!(prevClosing < closing && closing < nextClosing)) {
    return {
      ok: false,
      error: 'ClosingOutOfRange',
      message: `O fechamento precisa ficar depois de ${prevClosing} e antes de ${nextClosing}.`,
    };
  }

  const due = dueDate ?? defaults.nextDueDate;
  if (!(due > closing && due <= addDays(closing, MAX_DUE_AFTER_CLOSING_DAYS))) {
    return {
      ok: false,
      error: 'DueOutOfRange',
      message: `O vencimento precisa ficar depois do fechamento e até ${MAX_DUE_AFTER_CLOSING_DAYS} dias depois dele.`,
    };
  }
  return { ok: true, closingDate, dueDate };
}

/**
 * Recompute bill shifts after the cycle boundaries change (a per-cycle
 * closing override was set or cleared).
 *
 * Same idea as recomputeShiftForDateChange, with the date fixed and the
 * windows moving: a row whose natural cycle changes keeps showing on the
 * bill the user placed it on (`target = naturalBefore + shift`). Rows
 * without a shift are not passed in — they follow the new boundary, which is
 * the point of moving it.
 *
 * Returns only the rows whose shift changes: `shift: null` removes the shift
 * (the row now lands on its target naturally, or the target is out of the
 * ±1 reach — then its natural cycle is the least wrong place, as in the sync).
 * Rows outside findOffsetForDate's bound are left alone.
 */
export function realignShiftsForSettingsChange(
  before: CardSettings,
  after: CardSettings,
  rows: ReadonlyArray<{ id: string; date: string; shift: number }>,
  today: Date = new Date(),
): Array<{ id: string; shift: number | null }> {
  const changes: Array<{ id: string; shift: number | null }> = [];
  for (const r of rows) {
    const naturalBefore = findOffsetForDate(before, r.date, today);
    const naturalAfter = findOffsetForDate(after, r.date, today);
    if (naturalBefore === null || naturalAfter === null) continue;
    if (naturalBefore === naturalAfter) continue;
    const next = naturalBefore + r.shift - naturalAfter;
    const shift = next === 0 || Math.abs(next) > 1 ? null : next;
    if (shift !== r.shift) changes.push({ id: r.id, shift });
  }
  return changes;
}

/**
 * Find the bill offset whose due date falls in the target year/month.
 *
 * Different accounts have different closing_day/due_day, so the same calendar
 * month maps to different offsets per account. This helper bridges the gap:
 * the Overview navigates by calendar month, and each account resolves its own
 * offset via this function.
 *
 * Returns `null` if no offset within ±24 cycles matches (should never happen
 * in practice — it's a safety bound).
 */
export function findOffsetForDueMonth(
  settings: CardSettings,
  targetYear: number,
  targetMonth: number,
  today: Date = new Date(),
): number | null {
  // Compute offset 0's due date to get a reference point.
  const ref = computeBillWindowAtOffset(settings, 0, today);
  const [refY, refM] = ref.nextDueDate.split('-').map(Number);

  // Month difference gives us the estimated offset.
  const estimate = (targetYear - refY) * 12 + (targetMonth - refM);

  // Check the estimate and its immediate neighbors (off-by-one is possible
  // when due_day <= closing_day causes the due date to land in the next month).
  for (const candidate of [estimate, estimate - 1, estimate + 1]) {
    const w = computeBillWindowAtOffset(settings, candidate, today);
    const [y, m] = w.nextDueDate.split('-').map(Number);
    if (y === targetYear && m === targetMonth) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve which cycle a bill request targets: an explicit `offset`, or the
 * cycle whose due date falls in `dueMonth` (`YYYY-MM`). `dueMonth` wins when
 * both are given.
 *
 * Screens that navigate by calendar month (Overview) send `dueMonth` so the
 * month→offset conversion runs on this server's clock, the same one that
 * then computes the window at that offset. Resolving it in the browser
 * instead mixed two clocks: near a closing day, a browser still on the
 * previous date could ask for an offset the server reads one cycle apart.
 *
 * Returns `null` when no cycle within `findOffsetForDueMonth`'s bound matches.
 */
export function resolveBillOffset(
  settings: CardSettings,
  query: { offset?: number; dueMonth?: string },
  today: Date = new Date(),
): number | null {
  if (query.dueMonth) {
    const [y, m] = query.dueMonth.split('-').map(Number);
    return findOffsetForDueMonth(settings, y, m, today);
  }
  return query.offset ?? 0;
}
