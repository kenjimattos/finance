/**
 * Bill window math.
 *
 * Pluggy does NOT expose the currently open bill — its /bills endpoint only
 * returns closed bills, and `billId` on transactions is only populated after
 * closing. So we reconstruct the open-bill window ourselves, from the user's
 * configured closing_day + due_day (captured once per card in card_settings).
 *
 * The rules we follow:
 *  - The open bill window is (last closing_day, today], exclusive/inclusive.
 *  - If today's day-of-month is <= closing_day, last closing was this month;
 *    otherwise it was last month.
 *  - The open bill's due_date is the *next* occurrence of due_day that falls
 *    at least 1 day after the next closing_day. Usually that's the same month
 *    as the next closing (if due_day > closing_day) or the month after.
 *
 * Everything is computed in the America/Sao_Paulo timezone intent, but we
 * use UTC-safe date math (treat dates as yyyy-mm-dd strings, no times) to
 * avoid DST gotchas.
 */

export interface CardSettings {
  closingDay: number; // 1..28 — we clamp anything above to keep month math safe
  dueDay: number;
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
  const closingDay = clampDay(settings.closingDay);
  const dueDay = clampDay(settings.dueDay);

  const year = today.getFullYear();
  const month1 = today.getMonth() + 1;
  const day = today.getDate();

  // "Last closing" for the currently open bill — the day AFTER which offset=0 starts.
  let lastClosing: { year: number; month1: number };
  if (day <= closingDay) {
    lastClosing = addMonths(year, month1, -1);
  } else {
    lastClosing = { year, month1 };
  }

  // Shift the anchor by `offset` months to target a past/future cycle.
  const anchor = addMonths(lastClosing.year, lastClosing.month1, offset);

  const anchorClosingDate = ymd(anchor.year, anchor.month1, closingDay);
  const periodStart = addDays(anchorClosingDate, 1);

  const nextClosing = addMonths(anchor.year, anchor.month1, 1);
  const nextClosingDate = ymd(nextClosing.year, nextClosing.month1, closingDay);
  const periodEnd = nextClosingDate;

  // Due date: next occurrence of due_day that comes AFTER the next closing.
  // If due_day > closing_day, it's in the same month as the next closing.
  // If due_day <= closing_day, it's in the month after.
  const dueMonthOffset = dueDay > closingDay ? 0 : 1;
  const dueMonth = addMonths(nextClosing.year, nextClosing.month1, dueMonthOffset);
  const nextDueDate = ymd(dueMonth.year, dueMonth.month1, dueDay);

  return { periodStart, periodEnd, nextClosingDate, nextDueDate };
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
