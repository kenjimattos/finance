import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PluggyConnect } from 'react-pluggy-connect';
import { api } from '../../lib/api';
import type { Item, Account } from '../../lib/apiTypes';
import { keys } from '../../lib/queryKeys';

// ─── Add bank Button ──────────────────────────────────────────────────

function AddBank() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'syncing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const tokenMut = useMutation({
    mutationFn: api.connectToken,
    onSuccess: ({ accessToken }) => setToken(accessToken),
  });

  async function handleConnect(itemId: string) {
    setToken(null);
    setErrorMsg(null);
    try {
      setStatus('saving');
      await api.saveItem(itemId);

      setStatus('syncing');
      await api.syncTransactions(itemId);

      // Refresh everything so the new account appears.
      queryClient.invalidateQueries({ queryKey: keys.items() });
      queryClient.invalidateQueries({ queryKey: keys.accounts.all });
      queryClient.invalidateQueries({ queryKey: keys.accountSettings.all });
      queryClient.invalidateQueries({ queryKey: keys.billBreakdown.all });
      setStatus('idle');
    } catch (err) {
      console.error('[AddBank] failed:', err);
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Erro desconhecido');
      // Still refresh — the item may have been saved even if sync failed.
      queryClient.invalidateQueries({ queryKey: keys.items() });
      queryClient.invalidateQueries({ queryKey: keys.accounts.all });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          tokenMut.mutate();
        }}
        disabled={tokenMut.isPending || status === 'saving' || status === 'syncing'}
        className="flex items-center justify-center gap-2 px-5 py-4 text-center transition-colors hover:border-[color:var(--color-ink-muted)] disabled:opacity-50"
      >
        <span className="shrink-0 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50">
          {tokenMut.isPending
            ? 'Abrindo…'
            : status === 'saving'
              ? 'Salvando…'
              : status === 'syncing'
                ? 'Sincronizando…'
                : 'Adicionar banco +'}
        </span>

        {(status === 'error' || tokenMut.isError) && (
          <span className="mt-1 font-body text-xs text-[color:var(--color-accent)]">
            {errorMsg ?? 'Falha ao abrir o widget. Tente novamente.'}
          </span>
        )}
      </button>

      {token && (
        <PluggyConnect
          connectToken={token}
          includeSandbox={true}
          language="pt"
          theme="light"
          onSuccess={({ item }) => handleConnect(item.id)}
          onClose={() => setToken(null)}
          onError={() => setToken(null)}
        />
      )}
    </>
  );
}
// Map of substrings → display name, ordered by specificity. First match wins.
const BANK_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/banco do brasil|\bbb\b/i, 'Banco do Brasil'],
  [/ita[uú]/i, 'Itaú'],
  [/bradesco/i, 'Bradesco'],
  [/santander/i, 'Santander'],
  [/nubank|nu pagamentos/i, 'Nubank'],
  [/caixa/i, 'Caixa'],
  [/inter\b/i, 'Inter'],
  [/c6\b/i, 'C6'],
  [/picpay/i, 'PicPay'],
  [/mercado ?pago/i, 'Mercado Pago'],
  [/pag(seguro|bank)/i, 'PagBank'],
  [/safra/i, 'Safra'],
  [/btg/i, 'BTG'],
  [/\bxp\b/i, 'XP'],
  [/original/i, 'Original'],
  [/next\b/i, 'Next'],
  [/neon/i, 'Neon'],
  [/will\b/i, 'Will'],
];

function deriveBankName(accounts: Account[], fallback: string): string {
  for (const account of accounts) {
    if (!account.name) continue;
    for (const [pattern, display] of BANK_NAME_PATTERNS) {
      if (pattern.test(account.name)) return display;
    }
  }
  return fallback;
}

// ─── Remove bank Button ─────────────────────────────────────────

function RemoveItemGroup({
  item,
  accounts,
}: {
  item: Item;
  accounts: Account[];
}) {
  const queryClient = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.items() });
      queryClient.invalidateQueries({ queryKey: keys.accounts.all });
      queryClient.invalidateQueries({ queryKey: keys.billBreakdown.all });
    },
  });
  const connectorLabel = deriveBankName(accounts, item.connector_name ?? 'Banco');
  const isOrphan = accounts.length === 0;

  return (
    <div className="border-b border-[color:var(--color-ink-faint)] px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-ink)]">
          {connectorLabel}
          {isOrphan && (
            <span className="ml-2 text-[color:var(--color-accent)]">(sem contas)</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => {
            const msg = isOrphan
              ? `Remover o item "${connectorLabel}"?`
              : `Remover "${connectorLabel}" e todas as ${accounts.length} conta(s) associadas?`;
            if (window.confirm(msg)) deleteMut.mutate(item.id);
          }}
          className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-50"
        >
          🅧
        </button>
      </div>
    </div>
  );
}

// ── Manage banks ───────────────────────────────────────────────
export function ManageBankButton({
  items,
  accounts,
}: {
  items: Item[];
  accounts: Array<{ item: Item; account: Account }>;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuRef]);

  return (
    <div ref={menuRef}>
      <button
        type="button"
        onClick={() => setShowMenu((s) => !s)}
        className="flex items-center justify-center gap-2 px-5 py-8 text-center transition-colors hover:border-[color:var(--color-ink-muted)] hidden md:inline-flex"
      >
        <span className="shrink-0 font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]">
          Gerenciar bancos
        </span>
      </button>

      {showMenu && (
        <div className="mt-2 border shadow-lg absolute bg-[color:var(--color-paper)] min-w-[280px]">
          {items.length > 0 && (
            <div>
              {items.map((item) => {
                const itemAccounts = accounts
                  .filter((a) => a.item.id === item.id)
                  .map((a) => a.account);
                return (
                  <RemoveItemGroup
                    key={item.id}
                    item={item}
                    accounts={itemAccounts}
                  />
                );
              })}
            </div>
          )}
          <AddBank />
        </div>
      )}
    </div>
  );
}
