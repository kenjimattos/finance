/**
 * Tiny typed fetch wrapper over the @finance/api backend, plus one method per
 * endpoint. The response shapes live in ./apiTypes.
 *
 * During dev the Vite server proxies /api/* to http://localhost:3333,
 * so all URLs here are relative to /api. In prod the backend will serve
 * the built frontend and the same prefix works.
 */

import type {
  Account,
  AccountSettings,
  BillBreakdown,
  Card,
  CardGroup,
  CashFlowResponse,
  Category,
  CommitFaturaRow,
  ExtractedFaturaRow,
  Item,
  ManualEntry,
  PartnerCard,
  PartnerCardBreakdown,
  ReconcileReport,
  Rule,
  SplitSummary,
  Transaction,
} from './apiTypes';

const BASE = '/api';

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
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

// ── Endpoints ──

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

  syncCashFlow: () =>
    request<{ ok: true; transactions: number; prunedManualEntries: number }>(
      '/cashflow/sync',
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

  setTransactionHidden: (transactionId: string, hidden: boolean) =>
    request<{ ok: true; transactionId: string; hidden: boolean }>(
      `/transactions/${transactionId}/hidden`,
      {
        method: 'PUT',
        body: JSON.stringify({ hidden }),
      },
    ),

  createManualTransaction: (body: {
    accountId: string;
    date: string;
    description: string;
    amount: number;
    cardLast4?: string;
    categoryId?: number;
    installmentNumber?: number | null;
    totalInstallments?: number | null;
  }) =>
    request<{ ok: true; id: string }>('/transactions/manual', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateManualTransaction: (
    id: string,
    body: Partial<{
      date: string;
      description: string;
      amount: number;
      cardLast4: string | null;
      installmentNumber: number | null;
      totalInstallments: number | null;
    }>,
  ) =>
    request<{ ok: true }>(`/transactions/manual/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteManualTransaction: (id: string) =>
    request<void>(`/transactions/manual/${encodeURIComponent(id)}`, {
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

  // ── Cash Flow ──

  getCashFlow: (month?: string) => {
    const qs = month ? `?month=${encodeURIComponent(month)}` : '';
    return request<CashFlowResponse>(`/cashflow${qs}`);
  },

  getCashFlowRange: () =>
    request<{ firstMonth: string | null; lastMonth: string | null }>('/cashflow/range'),

  tagBillPayment: (transactionId: string) =>
    request<{ ok: true }>(`/cashflow/bill-tag/${encodeURIComponent(transactionId)}`, { method: 'PUT' }),

  untagBillPayment: (transactionId: string) =>
    request<{ ok: true }>(`/cashflow/bill-tag/${encodeURIComponent(transactionId)}`, { method: 'DELETE' }),

  hideBankTransaction: (transactionId: string) =>
    request<{ ok: true }>(`/cashflow/hide/${encodeURIComponent(transactionId)}`, { method: 'PUT' }),

  unhideBankTransaction: (transactionId: string) =>
    request<{ ok: true }>(`/cashflow/hide/${encodeURIComponent(transactionId)}`, { method: 'DELETE' }),

  listManualEntries: () => request<ManualEntry[]>('/manual-entries'),

  createManualEntry: (body: {
    description: string;
    amount: number;
    dayOfMonth: number;
    month: string;
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
      sortKey: number | null;
    }>,
  ) =>
    request<ManualEntry>(`/manual-entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteManualEntry: (id: number) =>
    request<void>(`/manual-entries/${id}`, { method: 'DELETE' }),

  setBankTransactionSortKey: (transactionId: string, sortKey: number | null) =>
    request<{ ok: true }>(
      `/bank-transactions/${encodeURIComponent(transactionId)}/sort-key`,
      {
        method: 'PUT',
        body: JSON.stringify({ sortKey }),
      },
    ),

  updateTransactionDescription: (transactionId: string, description: string) =>
    request<{ ok: true }>(
      `/bank-transactions/${encodeURIComponent(transactionId)}/description`,
      {
        method: 'PUT',
        body: JSON.stringify({ description }),
      },
    ),

  deleteTransactionDescription: (transactionId: string) =>
    request<void>(
      `/bank-transactions/${encodeURIComponent(transactionId)}/description`,
      { method: 'DELETE' },
    ),

  // ── Splits ──

  splitTransaction: (transactionId: string, splitType: 'half' | 'theirs') =>
    request<{ transactionId: string; splitType: string }>(
      `/transactions/${encodeURIComponent(transactionId)}/split`,
      { method: 'PUT', body: JSON.stringify({ splitType }) },
    ),

  unsplitTransaction: (transactionId: string) =>
    request<void>(
      `/transactions/${encodeURIComponent(transactionId)}/split`,
      { method: 'DELETE' },
    ),

  bulkSplit: (transactionIds: string[], splitType: 'half' | 'theirs') =>
    request<{ applied: number }>('/transactions/bulk-split', {
      method: 'POST',
      body: JSON.stringify({ transactionIds, splitType }),
    }),

  bulkUnsplit: (transactionIds: string[]) =>
    request<{ removed: number }>('/transactions/bulk-unsplit', {
      method: 'POST',
      body: JSON.stringify({ transactionIds }),
    }),

  getSplitSummary: (accountId: string, offset?: number) => {
    const qs = new URLSearchParams({ accountId });
    if (offset !== undefined && offset !== 0) qs.set('offset', String(offset));
    return request<SplitSummary>(`/bills/current/split-summary?${qs}`);
  },

  listPartnerCards: () => request<PartnerCard[]>('/partner/cards'),

  getPartnerCardBreakdown: (owner: string, accountId: string, offset?: number) => {
    const qs = new URLSearchParams({ owner, accountId });
    if (offset !== undefined && offset !== 0) qs.set('offset', String(offset));
    return request<PartnerCardBreakdown>(`/partner/cards/breakdown?${qs}`);
  },

  getAuthMe: () =>
    request<{
      authenticated: boolean;
      username?: string;
      demo?: boolean;
      features?: { importFaturaEnabled: boolean };
    }>('/auth/me'),

  // ── Fatura import (screenshots → manual transactions) ──
  extractFatura: (body: {
    accountId: string;
    billOffset: number;
    images: { data: string; mediaType: string }[];
  }) =>
    request<{
      window: { periodStart: string; periodEnd: string; nextDueDate: string };
      rows: ExtractedFaturaRow[];
    }>('/transactions/import-fatura/extract', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  commitFaturaImport: (body: { accountId: string; rows: CommitFaturaRow[] }) =>
    request<{ ok: true; count: number; ids: string[] }>(
      '/transactions/import-fatura/commit',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  // The PDF itself, base64: the model reads the real layout. Encrypted files
  // are rejected in the browser before this call (lib/pdfFile.ts).
  reconcileFatura: (body: { accountId: string; billOffset: number; pdfBase64: string }) =>
    request<ReconcileReport>('/transactions/import-fatura/reconcile', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (username: string, password: string) =>
    request<{ ok: boolean; username?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};
