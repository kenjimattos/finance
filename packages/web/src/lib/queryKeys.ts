/**
 * Single source of truth for every TanStack Query key in the app.
 *
 * Why this exists: query keys are matched by prefix, so invalidating with a
 * hand-written literal is silently a no-op when the literal drifts from the
 * one the query was registered with — no type error, no runtime error, just a
 * panel that stays stale. Routing every key through this factory makes the
 * compiler catch the drift.
 *
 * Shape convention: each domain exposes `all` (the broadest prefix, for
 * invalidation) plus narrower builders. Narrow keys must always *extend* the
 * broader ones, so invalidating `all` reaches every descendant.
 */

export const keys = {
  /** Session / current user. `api.getAuthMe` — one key, one cache entry. */
  auth: () => ['auth'] as const,

  items: () => ['items'] as const,

  accounts: {
    all: ['accounts'] as const,
    ofItem: (itemId: string) => ['accounts', itemId] as const,
  },

  accountSettings: {
    all: ['accountSettings'] as const,
    of: (accountId: string) => ['accountSettings', accountId] as const,
  },

  transactions: {
    all: ['transactions'] as const,
    ofItem: (itemId: string) => ['transactions', itemId] as const,
    list: (p: {
      itemId: string;
      accountId: string;
      periodStart: string;
      periodEnd: string;
      cardGroupId: string | undefined;
    }) =>
      [
        'transactions',
        p.itemId,
        p.accountId,
        p.periodStart,
        p.periodEnd,
        p.cardGroupId ?? 'all',
      ] as const,
  },

  categories: () => ['categories'] as const,

  rules: {
    all: ['rules'] as const,
    search: (term: string) => ['rules', term] as const,
  },

  billBreakdown: {
    all: ['billBreakdown'] as const,
    ofItem: (itemId: string) => ['billBreakdown', itemId] as const,
    /**
     * `offset` is nullable on purpose: Overview resolves one offset per
     * account and leaves the query disabled when there is none, so `null`
     * is a real key that lives in the cache.
     */
    at: (itemId: string, accountId: string, offset: number | null) =>
      ['billBreakdown', itemId, accountId, offset] as const,
  },

  splitSummary: {
    all: ['splitSummary'] as const,
    ofAccount: (accountId: string) => ['splitSummary', accountId] as const,
    at: (accountId: string, offset: number | null) =>
      ['splitSummary', accountId, offset] as const,
  },

  partnerCards: () => ['partnerCards'] as const,

  partnerCardBreakdown: {
    all: ['partnerCardBreakdown'] as const,
    at: (owner: string, accountId: string, offset: number | null) =>
      ['partnerCardBreakdown', owner, accountId, offset] as const,
  },

  cashflow: {
    all: ['cashflow'] as const,
    month: (monthStr: string) => ['cashflow', monthStr] as const,
    range: ['cashflow-range'] as const,
  },

  cardGroups: {
    all: ['cardGroups'] as const,
    ofItem: (itemId: string) => ['cardGroups', itemId] as const,
    of: (itemId: string, accountId: string) =>
      ['cardGroups', itemId, accountId] as const,
  },

  cards: {
    all: ['cards'] as const,
    ofItem: (itemId: string) => ['cards', itemId] as const,
    of: (itemId: string, accountId: string) =>
      ['cards', itemId, accountId] as const,
  },

  /** Local-only key: holds the "sync?" prompt state, never fetched. */
  syncPrompt: (itemId: string) => ['_sync_prompt', itemId] as const,
};
