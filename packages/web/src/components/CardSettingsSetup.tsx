import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

/**
 * First-time setup for a card: ask the user for the closing day and due day.
 * Shown whenever /card-settings/:itemId returns 404. Pluggy can't tell us
 * these values — they have to come from the user, once.
 */
export function CardSettingsSetup({ itemId }: { itemId: string }) {
  const [closingDay, setClosingDay] = useState<number>(16);
  const [dueDay, setDueDay] = useState<number>(25);
  const [displayName, setDisplayName] = useState<string>('');
  const queryClient = useQueryClient();

  const mut = useMutation({
    mutationFn: () =>
      api.putCardSettings(itemId, {
        closingDay,
        dueDay,
        displayName: displayName.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cardSettings', itemId] });
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    },
  });

  return (
    <section className="max-w-[520px]">
      <div className="eyebrow mb-3">Configuração única</div>
      <h2 className="font-display text-4xl leading-[1.05] tracking-tight text-[color:var(--color-ink)]">
        Quando seu cartão fecha e vence?
      </h2>
      <p className="mt-4 max-w-[48ch] text-sm leading-relaxed text-[color:var(--color-ink-muted)]">
        O Pluggy não expõe essas datas, então precisamos que você informe
        uma vez. A partir disso, calculamos qual é a fatura em aberto e
        quanto você já gastou nela.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
        className="mt-8 space-y-6"
      >
        <Field label="Nome do cartão (opcional)">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Nubank Roxinho"
            className="w-full border-0 border-b border-[color:var(--color-ink-faint)] bg-transparent py-2 font-display text-2xl text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        </Field>

        <div className="grid grid-cols-2 gap-8">
          <Field label="Dia do fechamento">
            <DayInput value={closingDay} onChange={setClosingDay} />
          </Field>
          <Field label="Dia do vencimento">
            <DayInput value={dueDay} onChange={setDueDay} />
          </Field>
        </div>

        <p className="font-mono text-xs text-[color:var(--color-ink-faint)]">
          Ex.: fechamento 16, vencimento 25 → compras de 17/mar a 16/abr vencem em 25/abr
        </p>

        <button
          type="submit"
          disabled={mut.isPending}
          className="inline-flex items-center gap-3 border border-[color:var(--color-ink)] bg-[color:var(--color-ink)] px-6 py-3 font-body text-sm font-medium uppercase tracking-[0.14em] text-[color:var(--color-paper)] transition-colors hover:bg-[color:var(--color-accent)] hover:border-[color:var(--color-accent)] disabled:opacity-50"
        >
          {mut.isPending ? 'Salvando…' : 'Salvar e continuar'}
          <span aria-hidden="true">→</span>
        </button>

        {mut.isError && (
          <p className="text-sm text-[color:var(--color-accent)]">
            {mut.error instanceof ApiError
              ? mut.error.message
              : 'Erro ao salvar — tente novamente.'}
          </p>
        )}
      </form>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function DayInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={1}
      max={28}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(1, Math.min(28, n)));
      }}
      className="w-full border-0 border-b border-[color:var(--color-ink-faint)] bg-transparent py-2 font-mono text-3xl text-[color:var(--color-ink)] focus:border-[color:var(--color-accent)] focus:outline-none"
    />
  );
}
