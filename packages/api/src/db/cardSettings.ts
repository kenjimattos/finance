import type { Db } from './index.js';
import type { CardSettings, CycleOverride } from '../services/billWindow.js';

export interface AccountCardSettings extends CardSettings {
  displayName: string | null;
}

/**
 * Everything the bill-window math needs for one account: the default
 * closing/due days from account_settings plus its per-cycle overrides.
 * Returns null when the account has no settings yet. Every caller that
 * computes a bill window loads settings through here, so an override is
 * honored everywhere at once.
 */
export function loadAccountCardSettings(db: Db, accountId: string): AccountCardSettings | null {
  const row = db
    .prepare('SELECT display_name, closing_day, due_day FROM account_settings WHERE account_id = ?')
    .get(accountId) as { display_name: string | null; closing_day: number; due_day: number } | undefined;
  if (!row) return null;

  const overrides = new Map<string, CycleOverride>();
  const rows = db
    .prepare(
      'SELECT cycle_month, closing_date, due_date FROM bill_cycle_overrides WHERE account_id = ?',
    )
    .all(accountId) as Array<{ cycle_month: string; closing_date: string | null; due_date: string | null }>;
  for (const o of rows) {
    overrides.set(o.cycle_month, { closingDate: o.closing_date, dueDate: o.due_date });
  }

  return {
    displayName: row.display_name,
    closingDay: row.closing_day,
    dueDay: row.due_day,
    overrides,
  };
}
