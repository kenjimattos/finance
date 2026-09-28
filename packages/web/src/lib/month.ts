/**
 * Calendar-month arithmetic shared by the screens. Months are 1-based
 * `{ year, month }` pairs; `monthStr` is the `YYYY-MM` key the API and the
 * query cache use.
 */

export interface YearMonth {
  year: number;
  month: number;
}

export function addMonth(year: number, month: number, delta: number): YearMonth {
  const zeroBased = month - 1 + delta;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

export function monthStr(year: number, month: number): string {
  return `${year}-${month < 10 ? '0' : ''}${month}`;
}

/** Every month from start to end, both inclusive. */
export function monthRange(
  startY: number, startM: number,
  endY: number, endM: number,
): YearMonth[] {
  const result: YearMonth[] = [];
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    result.push({ year: y, month: m });
    ({ year: y, month: m } = addMonth(y, m, 1));
  }
  return result;
}
