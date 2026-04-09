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
  userCategory: UserCategoryRef | null;
}

export interface OpenBill {
  itemId: string;
  displayName: string | null;
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  total: number;
  previousTotal: number;
  delta: number;
}

export interface BillCategoryBreakdown {
  id: number;
  name: string;
  color: string;
  total: number;
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
}

export interface BillBreakdown {
  itemId: string;
  displayName: string | null;
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  /** First entry is always "Todos" (groupId: null). Empty groups are filtered out. */
  groups: BillGroupBreakdown[];
}

// ---------- Endpoints ----------

export const api = {
  connectToken: () =>
    request<{ accessToken: string }>('/connect-token', { method: 'POST' }),

  listItems: () => request<Item[]>('/items'),
  saveItem: (itemId: string) =>
    request<{ id: string; connectorName: string | null }>('/items', {
      method: 'POST',
      body: JSON.stringify({ itemId }),
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

  listCategories: () => request<Category[]>('/categories'),
  createCategory: (name: string) =>
    request<Category>('/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getCurrentBill: (itemId: string, cardGroupId?: string) => {
    const qs = new URLSearchParams({ itemId });
    if (cardGroupId) qs.set('cardGroupId', cardGroupId);
    return request<OpenBill>(`/bills/current?${qs}`);
  },

  getBillBreakdown: (itemId: string) =>
    request<BillBreakdown>(
      `/bills/current/breakdown?itemId=${encodeURIComponent(itemId)}`,
    ),

  listTransactions: (params: {
    itemId: string;
    from?: string;
    to?: string;
    uncategorized?: boolean;
    cardGroupId?: string;
  }) => {
    const qs = new URLSearchParams({ itemId: params.itemId });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.uncategorized) qs.set('uncategorized', 'true');
    if (params.cardGroupId) qs.set('cardGroupId', params.cardGroupId);
    return request<Transaction[]>(`/transactions?${qs}`);
  },

  listCards: (itemId: string) =>
    request<Card[]>(`/cards?itemId=${encodeURIComponent(itemId)}`),

  listCardGroups: (itemId: string) =>
    request<CardGroup[]>(`/card-groups?itemId=${encodeURIComponent(itemId)}`),

  createCardGroup: (itemId: string, name: string) =>
    request<CardGroup>('/card-groups', {
      method: 'POST',
      body: JSON.stringify({ itemId, name }),
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

  bulkCategorize: (transactionIds: string[], categoryId: number) =>
    request<{ ok: true; applied: number; total: number }>(
      '/transactions/bulk-categorize',
      {
        method: 'POST',
        body: JSON.stringify({ transactionIds, categoryId }),
      },
    ),
};
