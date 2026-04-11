import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBillWindowAtOffset,
  computeOpenBillWindow,
  computePreviousBillWindow,
  computeNextBillWindow,
} from './billWindow.js';

/** Helper: create a Date from yyyy-mm-dd without timezone surprises. */
function date(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ─── computeOpenBillWindow ───────────────────────────────────────────

describe('computeOpenBillWindow', () => {
  const settings = { closingDay: 7, dueDay: 15 };

  it('before closing day → window started last month', () => {
    const w = computeOpenBillWindow(settings, date('2025-03-05'));
    assert.equal(w.periodStart, '2025-02-08');
    assert.equal(w.periodEnd, '2025-03-07');
    assert.equal(w.nextClosingDate, '2025-03-07');
    assert.equal(w.nextDueDate, '2025-03-15');
  });

  it('on closing day → still in current window (day <= closingDay)', () => {
    const w = computeOpenBillWindow(settings, date('2025-03-07'));
    assert.equal(w.periodStart, '2025-02-08');
    assert.equal(w.periodEnd, '2025-03-07');
  });

  it('after closing day → new window started this month', () => {
    const w = computeOpenBillWindow(settings, date('2025-03-10'));
    assert.equal(w.periodStart, '2025-03-08');
    assert.equal(w.periodEnd, '2025-04-07');
    assert.equal(w.nextClosingDate, '2025-04-07');
    assert.equal(w.nextDueDate, '2025-04-15');
  });

  it('due day before closing day → due falls in next month', () => {
    const s = { closingDay: 20, dueDay: 5 };
    const w = computeOpenBillWindow(s, date('2025-03-25'));
    // After closing day 20 → window is Mar 21 – Apr 20
    assert.equal(w.periodStart, '2025-03-21');
    assert.equal(w.periodEnd, '2025-04-20');
    // dueDay (5) <= closingDay (20) → due is month after closing
    assert.equal(w.nextDueDate, '2025-05-05');
  });

  it('year boundary — December after closing rolls into January', () => {
    const w = computeOpenBillWindow(settings, date('2025-12-10'));
    assert.equal(w.periodStart, '2025-12-08');
    assert.equal(w.periodEnd, '2026-01-07');
    assert.equal(w.nextClosingDate, '2026-01-07');
    assert.equal(w.nextDueDate, '2026-01-15');
  });

  it('January before closing → last closing was December', () => {
    const w = computeOpenBillWindow(settings, date('2026-01-05'));
    assert.equal(w.periodStart, '2025-12-08');
    assert.equal(w.periodEnd, '2026-01-07');
  });

  it('clamps closing day > 28 to 28', () => {
    const s = { closingDay: 31, dueDay: 5 };
    const w = computeOpenBillWindow(s, date('2025-02-15'));
    // Clamped to 28 — Feb 15 < 28, so last closing was Jan 28
    assert.equal(w.periodStart, '2025-01-29');
    assert.equal(w.periodEnd, '2025-02-28');
  });
});

// ─── computePreviousBillWindow ───────────────────────────────────────

describe('computePreviousBillWindow', () => {
  const settings = { closingDay: 7, dueDay: 15 };

  it('returns the window one month before the current open bill', () => {
    const prev = computePreviousBillWindow(settings, date('2025-03-05'));
    // Current is Feb 8 – Mar 7, so previous is Jan 8 – Feb 7
    assert.equal(prev.periodStart, '2025-01-08');
    assert.equal(prev.periodEnd, '2025-02-07');
    assert.equal(prev.nextClosingDate, '2025-02-07');
    assert.equal(prev.nextDueDate, '2025-02-15');
  });
});

// ─── computeNextBillWindow ───────────────────────────────────────────

describe('computeNextBillWindow', () => {
  const settings = { closingDay: 7, dueDay: 15 };

  it('returns the window one month after the current open bill', () => {
    const next = computeNextBillWindow(settings, date('2025-03-05'));
    // Current is Feb 8 – Mar 7, so next is Mar 8 – Apr 7
    assert.equal(next.periodStart, '2025-03-08');
    assert.equal(next.periodEnd, '2025-04-07');
    assert.equal(next.nextClosingDate, '2025-04-07');
    assert.equal(next.nextDueDate, '2025-04-15');
  });
});

// ─── computeBillWindowAtOffset ───────────────────────────────────────

describe('computeBillWindowAtOffset', () => {
  const settings = { closingDay: 7, dueDay: 15 };

  it('offset 0 matches computeOpenBillWindow', () => {
    const today = date('2025-03-05');
    const open = computeOpenBillWindow(settings, today);
    const offset0 = computeBillWindowAtOffset(settings, 0, today);
    assert.deepEqual(offset0, open);
  });

  it('offset -1 matches computePreviousBillWindow', () => {
    const today = date('2025-03-05');
    const prev = computePreviousBillWindow(settings, today);
    const offsetMinus1 = computeBillWindowAtOffset(settings, -1, today);
    assert.deepEqual(offsetMinus1, prev);
  });

  it('offset +1 matches computeNextBillWindow', () => {
    const today = date('2025-03-05');
    const next = computeNextBillWindow(settings, today);
    const offsetPlus1 = computeBillWindowAtOffset(settings, 1, today);
    assert.deepEqual(offsetPlus1, next);
  });

  it('offset -3 walks back three full cycles', () => {
    // today 2025-03-05, current is Feb 8 – Mar 7.
    // -1 = Jan 8 – Feb 7, -2 = Dec 8 – Jan 7, -3 = Nov 8 – Dec 7.
    const w = computeBillWindowAtOffset(settings, -3, date('2025-03-05'));
    assert.equal(w.periodStart, '2024-11-08');
    assert.equal(w.periodEnd, '2024-12-07');
    assert.equal(w.nextClosingDate, '2024-12-07');
    assert.equal(w.nextDueDate, '2024-12-15');
  });

  it('offset crossing year boundary backwards', () => {
    // today 2026-01-05 (before closing) → current is Dec 8 – Jan 7.
    // offset -1 → Nov 8 – Dec 7 (2025).
    const w = computeBillWindowAtOffset(settings, -1, date('2026-01-05'));
    assert.equal(w.periodStart, '2025-11-08');
    assert.equal(w.periodEnd, '2025-12-07');
    assert.equal(w.nextDueDate, '2025-12-15');
  });

  it('preserves dueDay <= closingDay rule across offsets', () => {
    // dueDay (5) <= closingDay (20) → due is the month AFTER next closing.
    // This must hold at any offset, not just the open bill.
    const s = { closingDay: 20, dueDay: 5 };
    const w = computeBillWindowAtOffset(s, -2, date('2025-06-15'));
    // today 2025-06-15 (before closing 20) → current Jun is May 21 – Jun 20.
    // offset -2 → Mar 21 – Apr 20. Next closing Apr 20, due May 5.
    assert.equal(w.periodStart, '2025-03-21');
    assert.equal(w.periodEnd, '2025-04-20');
    assert.equal(w.nextClosingDate, '2025-04-20');
    assert.equal(w.nextDueDate, '2025-05-05');
  });

  it('consecutive offsets are contiguous', () => {
    // The end of offset N should equal the start of offset N+1 minus one day.
    const today = date('2025-06-15');
    const a = computeBillWindowAtOffset(settings, -2, today);
    const b = computeBillWindowAtOffset(settings, -1, today);
    const c = computeBillWindowAtOffset(settings, 0, today);
    assert.equal(addOneDay(a.periodEnd), b.periodStart);
    assert.equal(addOneDay(b.periodEnd), c.periodStart);
  });
});

function addOneDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// ─── Three windows are contiguous ────────────────────────────────────

describe('window contiguity', () => {
  it('previous.periodEnd + 1 day === current.periodStart', () => {
    const settings = { closingDay: 10, dueDay: 25 };
    const today = date('2025-06-15');
    const prev = computePreviousBillWindow(settings, today);
    const curr = computeOpenBillWindow(settings, today);
    const next = computeNextBillWindow(settings, today);

    // Previous ends on its closing day, current starts the day after
    assert.equal(prev.periodEnd, '2025-06-10');
    assert.equal(curr.periodStart, '2025-06-11');

    // Current ends on closing day, next starts the day after
    assert.equal(curr.periodEnd, '2025-07-10');
    assert.equal(next.periodStart, '2025-07-11');
  });
});
