/**
 * Lightweight bill-window math for the frontend.
 *
 * Mirrors the core logic from packages/api/src/services/billWindow.ts so the
 * Overview screen can resolve "which offset corresponds to due-month April 2026?"
 * per account without a round-trip.
 */

interface CardSettings {
  closingDay: number;
  dueDay: number;
}

function clampDay(day: number): number {
  if (day < 1) return 1;
  if (day > 28) return 28;
  return Math.floor(day);
}

function addMonths(year: number, month1: number, delta: number): { year: number; month1: number } {
  const zeroBased = month1 - 1 + delta;
  const newYear = year + Math.floor(zeroBased / 12);
  const newMonth = ((zeroBased % 12) + 12) % 12;
  return { year: newYear, month1: newMonth + 1 };
}

/**
 * Compute the due date's year+month for a given offset from today.
 * This is just enough math to resolve offsets — we don't need full BillWindow.
 */
function dueDateMonth(
  settings: CardSettings,
  offset: number,
  today: Date,
): { year: number; month: number } {
  const closingDay = clampDay(settings.closingDay);
  const dueDay = clampDay(settings.dueDay);

  const year = today.getFullYear();
  const month1 = today.getMonth() + 1;
  const day = today.getDate();

  // "Last closing" for the currently open bill
  let lastClosing: { year: number; month1: number };
  if (day <= closingDay) {
    lastClosing = addMonths(year, month1, -1);
  } else {
    lastClosing = { year, month1 };
  }

  // Shift by offset
  const anchor = addMonths(lastClosing.year, lastClosing.month1, offset);
  const nextClosing = addMonths(anchor.year, anchor.month1, 1);

  // Due month
  const dueMonthOffset = dueDay > closingDay ? 0 : 1;
  const dueMonth = addMonths(nextClosing.year, nextClosing.month1, dueMonthOffset);

  return { year: dueMonth.year, month: dueMonth.month1 };
}

/**
 * Find the bill offset whose due date falls in targetYear/targetMonth.
 *
 * Same algorithm as the backend's findOffsetForDueMonth: compute offset 0's
 * due month, estimate the delta, check ±1 neighbors.
 */
export function findOffsetForDueMonth(
  settings: CardSettings,
  targetYear: number,
  targetMonth: number,
  today: Date = new Date(),
): number | null {
  const ref = dueDateMonth(settings, 0, today);
  const estimate = (targetYear - ref.year) * 12 + (targetMonth - ref.month);

  for (const candidate of [estimate, estimate - 1, estimate + 1]) {
    const dm = dueDateMonth(settings, candidate, today);
    if (dm.year === targetYear && dm.month === targetMonth) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get the due-date year+month for the currently open bill (offset 0).
 * Used to initialize the Overview's target month.
 */
export function currentDueMonth(
  settings: CardSettings,
  today: Date = new Date(),
): { year: number; month: number } {
  return dueDateMonth(settings, 0, today);
}
