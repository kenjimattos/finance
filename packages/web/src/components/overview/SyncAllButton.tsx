import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Item } from '../../lib/apiTypes';
import { keys } from '../../lib/queryKeys';

// ─── Sync all button ────────────────────────────────────────────────

export function SyncAllButton({ items }: { items: Item[] }) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await Promise.all(items.map((item) => api.syncTransactions(item.id)));
      queryClient.invalidateQueries({ queryKey: keys.items() });
      queryClient.invalidateQueries({ queryKey: keys.accounts.all });
      queryClient.invalidateQueries({ queryKey: keys.accountSettings.all });
      queryClient.invalidateQueries({ queryKey: keys.billBreakdown.all });
      queryClient.invalidateQueries({ queryKey: keys.transactions.all });
    } catch (err) {
      console.error('[SyncAll] failed:', err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSync}
      disabled={syncing}
      className="shrink-0 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
    >
      {syncing ? 'sincronizando…' : 'sincronizar ↻'}
    </button>
  );
}
