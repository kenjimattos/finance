import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { keys } from './queryKeys';

/**
 * Every mutation that edits a transaction inside a bill, with its cache
 * invalidation already correct.
 *
 * Why these live together: "what to refetch after a transaction changes" is
 * one piece of knowledge, and it was previously written out by hand at a
 * dozen call sites — which is how they drifted apart. Three server-side
 * views derive from the same rows:
 *
 * - the transaction list itself;
 * - GET /bills/current/breakdown, which sums only categorized rows;
 * - GET /bills/current/split-summary, which INNER JOINs
 *   `transaction_categories` and honors `transaction_bill_overrides`.
 *
 * That third one is the subtle one. Because it joins on categories and
 * resolves the bill window through the shift override, *categorizing* a row
 * or *shifting* it changes the split summary — not just splitting it. The
 * old hand-written invalidations missed both cases, leaving the split
 * columns stale after a categorize or a shift.
 *
 * This hook deliberately owns invalidation and nothing else. UI side effects
 * (closing a form, clearing the selection, showing a toast) belong to the
 * component and are passed per call, via the second argument of `.mutate()`.
 */
export function useBillMutations({
  itemId,
  accountId,
}: {
  itemId: string;
  accountId: string;
}) {
  const queryClient = useQueryClient();

  /** The rows of a bill, or one row's weight in it, changed. */
  function invalidateBill() {
    queryClient.invalidateQueries({ queryKey: keys.transactions.ofItem(itemId) });
    queryClient.invalidateQueries({ queryKey: keys.billBreakdown.ofItem(itemId) });
    queryClient.invalidateQueries({ queryKey: keys.splitSummary.ofAccount(accountId) });
  }

  /**
   * Same, plus the category list — GET /categories orders by `usage_count`,
   * so assigning or clearing a category reorders the picker.
   */
  function invalidateBillAndCategories() {
    invalidateBill();
    queryClient.invalidateQueries({ queryKey: keys.categories() });
  }

  const assign = useMutation({
    mutationFn: ({ txId, categoryId }: { txId: string; categoryId: number }) =>
      api.assignCategory(txId, categoryId),
    onSuccess: invalidateBillAndCategories,
  });

  const clear = useMutation({
    mutationFn: (txId: string) => api.clearCategory(txId),
    onSuccess: invalidateBillAndCategories,
  });

  const bulkCategorize = useMutation({
    mutationFn: ({ txIds, categoryId }: { txIds: string[]; categoryId: number }) =>
      api.bulkCategorize(txIds, categoryId),
    onSuccess: invalidateBillAndCategories,
  });

  const shift = useMutation({
    mutationFn: ({ txId, shift }: { txId: string; shift: -1 | 0 | 1 }) =>
      api.shiftTransactionBill(txId, shift),
    onSuccess: invalidateBill,
  });

  const setHidden = useMutation({
    mutationFn: ({ txId, hidden }: { txId: string; hidden: boolean }) =>
      api.setTransactionHidden(txId, hidden),
    onSuccess: invalidateBill,
  });

  const split = useMutation({
    mutationFn: ({ txId, splitType }: { txId: string; splitType: 'half' | 'theirs' }) =>
      api.splitTransaction(txId, splitType),
    onSuccess: invalidateBill,
  });

  const unsplit = useMutation({
    mutationFn: (txId: string) => api.unsplitTransaction(txId),
    onSuccess: invalidateBill,
  });

  const bulkSplit = useMutation({
    mutationFn: ({ txIds, splitType }: { txIds: string[]; splitType: 'half' | 'theirs' }) =>
      api.bulkSplit(txIds, splitType),
    onSuccess: invalidateBill,
  });

  const bulkUnsplit = useMutation({
    mutationFn: (txIds: string[]) => api.bulkUnsplit(txIds),
    onSuccess: invalidateBill,
  });

  const createManual = useMutation({
    mutationFn: (body: Parameters<typeof api.createManualTransaction>[0]) =>
      api.createManualTransaction(body),
    onSuccess: invalidateBill,
  });

  const updateManual = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Parameters<typeof api.updateManualTransaction>[1];
    }) => api.updateManualTransaction(id, body),
    onSuccess: invalidateBill,
  });

  const deleteManual = useMutation({
    mutationFn: (id: string) => api.deleteManualTransaction(id),
    onSuccess: invalidateBill,
  });

  return {
    assign,
    clear,
    bulkCategorize,
    shift,
    setHidden,
    split,
    unsplit,
    bulkSplit,
    bulkUnsplit,
    createManual,
    updateManual,
    deleteManual,
  };
}
