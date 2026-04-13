/**
 * Tiny typed fetch wrapper over the @finance/api backend.
 *
 * During dev the Vite server proxies /api/* to http://localhost:3333,
 * so all URLs here are relative to /api. In prod the backend will serve
 * the built frontend and the same prefix works.
 */

const BASE = '/api';

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------- Types ----------

export interface Item {
  id: string;
  connector_name: string | null;
  created_at: string;
}

export interface Account {
  id: string;
  itemId: string;
  name: string | null;
  number: string | null;
  type: string | null;
  syncedAt: string;
}

export interface AccountSettings {
  account_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
  created_at: string;
  updated_at: string;
}

export interface CardSettings {
  item_id: string;
  display_name: string | null;
  closing_day: number;
  due_day: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  usage_count: number;
  created_at: string;
}

export interface CardGroup {
  id: number;
  item_id: string;
  account_id: string | null;
  name: string;
  color: string;
  memberCount: number;
  created_at: string;
  updated_at: string;
}

export interface Card {
  cardLast4: string;
  txCount: number;
  lastUsed: string;
  group: { id: number; name: string; color: string } | null;
}

/**
 * Frontend-wide filter state for "which cards should I see?".
 * 'all' → no filter, show everything
 * 'none' → show only transactions from cards with no group
 * number → show only that group
 */
export type CardGroupFilter = 'all' | 'none' | number;

export function cardGroupFilterToQuery(f: CardGroupFilter): string | undefined {
  if (f === 'all') return undefined;
  if (f === 'none') return 'none';
  return String(f);
}

export interface UserCategoryRef {
  id: number;
  name: string;
  color: string;
  assignedBy: 'manual' | 'bulk' | 'learned' | null;
}

export interface Transaction {
  id: string;
  accountId: string;
  itemId: string;
  date: string; // yyyy-mm-dd
  description: string | null;
  amount: number;
  currencyCode: string | null;
  pluggyCategory: string | null;
  type: string | null;
  status: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  billId: string | null;
  cardLast4: string | null;
  /** -1 = pulled from next cycle, +1 = pushed from previous cycle, null = unshifted */
  billShift: -1 | 1 | null;
  userCategory: UserCategoryRef | null;
}

export interface Rule {
  id: number;
  merchant_slug: string;
  hit_count: number;
  override_count: number;
  disabled: number;
  user_category_id: number;
  user_category_name: string;
  user_category_color: string;
  created_at: string;
}

export interface BillCategoryBreakdown {
  id: number;
  name: string;
  color: string;
  total: number;
}

export interface BillInstallmentBreakdown {
  id: string;
  date: string;
  description: string | null;
  amount: number;
  installmentNumber: number;
  totalInstallments: number;
}

export interface BillGroupBreakdown {
  /** null for the "all" slot; number for a concrete card group */
  groupId: number | null;
  name: string;
  color: string | null;
  total: number;
  previousTotal: number;
  delta: number;
  categories: BillCategoryBreakdown[];
  installments: BillInstallmentBreakdown[];
}

export interface BillBreakdown {
  itemId: string;
  accountId: string | null;
  displayName: string | null;
  /** 0 = currently open bill, -N = N cycles in the past. Echoed back from the request. */
  offset: number;
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  /** Adjacent windows — needed so callers can ask /transactions for a shift-aware list. */
  previousPeriodStart: string;
  previousPeriodEnd: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
  /** First entry is always "Todos" (groupId: null). Empty groups are filtered out. */
  groups: BillGroupBreakdown[];
}

// ---------- Cash Flow ----------

export interface ManualEntry {
  id: number;
  description: string;
  amount: number;
  dayOfMonth: number;
  active: boolean;
  createdAt: string;
}

export interface CashFlowEntry {
  id: string;
  description: string;
  amount: number;
  type: 'bank_transaction' | 'manual_entry' | 'credit_card_bill';
  accountId?: string;
  bankAccountId?: string;
}

export interface CashFlowDay {
  date: string;
  isPast: boolean;
  entries: CashFlowEntry[];
}

export interface CashFlowBankAccount {
  id: string;
  name: string | null;
  balance: number | null;
  openingBalance: number | null;
}

export interface CashFlowResponse {
  month: string;
  bankAccounts: CashFlowBankAccount[];
  days: CashFlowDay[];
}

// ---------- Endpoints ----------

export const api = {
  connectToken: () =>
    request<{ accessToken: string }>('/connect-token', { method: 'POST' }),

  listItems: () => request<Item[]>('/items'),

  listAccounts: (itemId: string) =>
    request<Account[]>(`/accounts?itemId=${encodeURIComponent(itemId)}`),
  saveItem: (itemId: string) =>
    request<{ id: string; connectorName: string | null }>('/items', {
      method: 'POST',
      body: JSON.stringify({ itemId }),
    }),

  deleteItem: (itemId: string) =>
    request<void>(`/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),

  getAccountSettings: (accountId: string) =>
    request<AccountSettings>(`/account-settings/${accountId}`),
  putAccountSettings: (
    accountId: string,
    body: { displayName?: string; closingDay: number; dueDay: number },
  ) =>
    request<AccountSettings>(`/account-settings/${accountId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getCardSettings: (itemId: string) =>
    request<CardSettings>(`/card-settings/${itemId}`),
  putCardSettings: (
    itemId: string,
    body: { displayName?: string; closingDay: number; dueDay: number },
  ) =>
    request<CardSettings>(`/card-settings/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  listRules: (q?: string) => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    return request<Rule[]>(`/rules${qs}`);
  },
  deleteRule: (id: number) =>
    request<unknown>(`/rules/${id}`, { method: 'DELETE' }),
  updateRule: (id: number, categoryId: number) =>
    request<{ ok: true }>(`/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId }),
    }),

  listCategories: () => request<Category[]>('/categories'),
  createCategory: (name: string) =>
    request<Category>('/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getBillBreakdown: (itemId: string, accountId?: string, offset?: number) => {
    const qs = new URLSearchParams({ itemId });
    if (accountId) qs.set('accountId', accountId);
    if (offset !== undefined && offset !== 0) qs.set('offset', String(offset));
    return request<BillBreakdown>(`/bills/current/breakdown?${qs}`);
  },

  listTransactions: (params: {
    itemId: string;
    accountId?: string;
    from?: string;
    to?: string;
    uncategorized?: boolean;
    cardGroupId?: string;
    /** Passing all four neighbor-window fields switches the backend to shift-aware mode. */
    previousFrom?: string;
    previousTo?: string;
    nextFrom?: string;
    nextTo?: string;
  }) => {
    const qs = new URLSearchParams({ itemId: params.itemId });
    if (params.accountId) qs.set('accountId', params.accountId);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.uncategorized) qs.set('uncategorized', 'true');
    if (params.cardGroupId) qs.set('cardGroupId', params.cardGroupId);
    if (params.previousFrom) qs.set('previousFrom', params.previousFrom);
    if (params.previousTo) qs.set('previousTo', params.previousTo);
    if (params.nextFrom) qs.set('nextFrom', params.nextFrom);
    if (params.nextTo) qs.set('nextTo', params.nextTo);
    return request<Transaction[]>(`/transactions?${qs}`);
  },

  listCards: (itemId: string, accountId?: string) => {
    const qs = new URLSearchParams({ itemId });
    if (accountId) qs.set('accountId', accountId);
    return request<Card[]>(`/cards?${qs}`);
  },

  listCardGroups: (itemId: string, accountId?: string) => {
    const qs = new URLSearchParams({ itemId });
    if (accountId) qs.set('accountId', accountId);
    return request<CardGroup[]>(`/card-groups?${qs}`);
  },

  createCardGroup: (itemId: string, name: string, accountId?: string) =>
    request<CardGroup>('/card-groups', {
      method: 'POST',
      body: JSON.stringify({ itemId, accountId, name }),
    }),

  renameCardGroup: (id: number, name: string) =>
    request<CardGroup>(`/card-groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),

  deleteCardGroup: (id: number) =>
    request<unknown>(`/card-groups/${id}`, { method: 'DELETE' }),

  assignCardToGroup: (
    cardLast4: string,
    itemId: string,
    cardGroupId: number | null,
  ) =>
    request<unknown>(`/cards/${cardLast4}/group`, {
      method: 'PUT',
      body: JSON.stringify({ itemId, cardGroupId }),
    }),

  syncTransactions: (itemId: string) =>
    request<{ ok: true; transactions: number; bills: number }>(
      `/transactions/sync?itemId=${encodeURIComponent(itemId)}`,
      { method: 'POST' },
    ),

  assignCategory: (transactionId: string, categoryId: number) =>
    request<unknown>(`/transactions/${transactionId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ categoryId }),
    }),

  clearCategory: (transactionId: string) =>
    request<unknown>(`/transactions/${transactionId}/category`, {
      method: 'DELETE',
    }),

  shiftTransactionBill: (transactionId: string, shift: -1 | 0 | 1) =>
    request<{ ok: true; transactionId: string; shift: number }>(
      `/transactions/${transactionId}/bill-shift`,
      {
        method: 'PUT',
        body: JSON.stringify({ shift }),
      },
    ),

  bulkCategorize: (transactionIds: string[], categoryId: number) =>
    request<{ ok: true; applied: number; total: number }>(
      '/transactions/bulk-categorize',
      {
        method: 'POST',
        body: JSON.stringify({ transactionIds, categoryId }),
      },
    ),

  // ── Cash Flow ──

  getCashFlow: () => request<CashFlowResponse>('/cashflow'),

  listManualEntries: () => request<ManualEntry[]>('/manual-entries'),

  createManualEntry: (body: {
    description: string;
    amount: number;
    dayOfMonth: number;
  }) =>
    request<ManualEntry>('/manual-entries', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateManualEntry: (
    id: number,
    body: Partial<{
      description: string;
      amount: number;
      dayOfMonth: number;
      active: boolean;
    }>,
  ) =>
    request<ManualEntry>(`/manual-entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteManualEntry: (id: number) =>
    request<void>(`/manual-entries/${id}`, { method: 'DELETE' }),

  updateTransactionDescription: (transactionId: string, description: string) =>
    request<{ ok: true }>(
      `/transactions/${encodeURIComponent(transactionId)}/description`,
      {
        method: 'PUT',
        body: JSON.stringify({ description }),
      },
    ),

  deleteTransactionDescription: (transactionId: string) =>
    request<void>(
      `/transactions/${encodeURIComponent(transactionId)}/description`,
      { method: 'DELETE' },
    ),
};
