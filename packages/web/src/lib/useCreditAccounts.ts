import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from './api';
import type { Account, AccountSettings, Item } from './apiTypes';
import { keys } from './queryKeys';

export interface AccountWithSettings {
  item: Item;
  account: Account;
  settings: AccountSettings;
}

/**
 * Every account across the linked items, with the credit ones split into
 * configured (closing/due days set) and unconfigured (settings 404 → needs
 * setup). `allAccounts` keeps every type, for the bank manager.
 */
export function useCreditAccounts(items: Item[]) {
  const accountQueries = useQueries({
    queries: items.map((item) => ({
      queryKey: keys.accounts.ofItem(item.id),
      queryFn: () => api.listAccounts(item.id),
    })),
  });

  const allAccounts = useMemo(() => {
    const result: { item: Item; account: Account }[] = [];
    accountQueries.forEach((q, i) => {
      q.data?.forEach((account) => result.push({ item: items[i], account }));
    });
    return result;
  }, [accountQueries, items]);

  const creditAccounts = useMemo(
    () => allAccounts.filter(({ account }) => account.type === 'CREDIT'),
    [allAccounts],
  );

  const settingsQueries = useQueries({
    queries: creditAccounts.map(({ account }) => ({
      queryKey: keys.accountSettings.of(account.id),
      queryFn: () => api.getAccountSettings(account.id),
      retry: false,
    })),
  });

  const { configured, unconfigured } = useMemo(() => {
    const configured: AccountWithSettings[] = [];
    const unconfigured: { item: Item; account: Account }[] = [];
    creditAccounts.forEach(({ item, account }, i) => {
      const sq = settingsQueries[i];
      if (sq?.data) {
        configured.push({ item, account, settings: sq.data });
      } else if (sq?.isError) {
        // 404 = no settings yet → needs setup
        unconfigured.push({ item, account });
      }
    });
    return { configured, unconfigured };
  }, [creditAccounts, settingsQueries]);

  const loading =
    accountQueries.some((q) => q.isLoading) || settingsQueries.some((q) => q.isLoading);

  return { allAccounts, configured, unconfigured, loading };
}
