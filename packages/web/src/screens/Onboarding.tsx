import { useState } from 'react';
import { PluggyConnect } from 'react-pluggy-connect';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api } from '../lib/api';

/**
 * First-run screen. The user has no linked card yet.
 *
 * Flow:
 *  1. Click "Conectar um cartão" → request a connect token from the backend
 *  2. Render <PluggyConnect> with that token (appears as a modal overlay)
 *  3. onSuccess: save item.id to our backend; invalidate items query so the
 *     App component swaps us out for the Dashboard
 */
export function Onboarding() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);

  const tokenMut = useMutation({
    mutationFn: api.connectToken,
    onSuccess: ({ accessToken }) => setToken(accessToken),
  });

  const saveMut = useMutation({
    mutationFn: (itemId: string) => api.saveItem(itemId),
    onSuccess: () => {
      setToken(null);
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.2, 0.65, 0.3, 0.9] }}
      className="pt-20"
    >
      <div className="eyebrow mb-4">Finance · edição pessoal</div>

      <h1 className="font-display text-[72px] leading-[0.92] tracking-[-0.02em] text-[color:var(--color-ink)] md:text-[108px]">
        Sua fatura,
        <br />
        <em className="text-[color:var(--color-accent)] not-italic">organizada</em>{' '}
        do seu jeito.
      </h1>

      <p className="mt-8 max-w-[46ch] text-lg leading-relaxed text-[color:var(--color-ink-soft)]">
        Conecte um cartão de crédito via Open Finance e categorize seus
        lançamentos com suas próprias categorias. O sistema aprende com você
        — depois de alguns cliques, novas transações começam a ser
        classificadas sozinhas.
      </p>

      <div className="mt-12 flex items-center gap-6">
        <button
          type="button"
          onClick={() => tokenMut.mutate()}
          disabled={tokenMut.isPending}
          className="group inline-flex items-center gap-3 border border-[color:var(--color-ink)] bg-[color:var(--color-ink)] px-6 py-4 font-body text-sm font-medium uppercase tracking-[0.14em] text-[color:var(--color-paper)] transition-colors hover:bg-[color:var(--color-accent)] hover:border-[color:var(--color-accent)] disabled:opacity-50"
        >
          {tokenMut.isPending ? 'Abrindo…' : 'Conectar um cartão'}
          <span
            aria-hidden="true"
            className="inline-block transition-transform group-hover:translate-x-1"
          >
            →
          </span>
        </button>
        {tokenMut.isError && (
          <span className="text-sm text-[color:var(--color-accent)]">
            Falha ao abrir o widget. Tente novamente.
          </span>
        )}
      </div>

      <div className="mt-16 max-w-[52ch] border-l-2 border-[color:var(--color-paper-rule)] pl-6 font-body text-sm text-[color:var(--color-ink-muted)]">
        <p>
          Seus dados de autenticação bancária nunca passam por aqui — o
          widget é carregado direto do Pluggy e só devolve um identificador
          de conexão para este servidor, que roda no seu próprio computador.
        </p>
      </div>

      {token && (
        <PluggyConnect
          connectToken={token}
          includeSandbox={true}
          language="pt"
          theme="light"
          onSuccess={({ item }) => saveMut.mutate(item.id)}
          onClose={() => setToken(null)}
          onError={() => setToken(null)}
        />
      )}
    </motion.section>
  );
}
