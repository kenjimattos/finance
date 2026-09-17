import { useRef, useState } from 'react';
import type { Transaction } from '../lib/api';

/**
 * Inline form for creating or editing a manual bill transaction.
 * Matches the editorial/broadsheet visual language — no card, no rounded
 * corners, just fields on paper with a border-bottom rule.
 */
export function ManualTransactionForm({
  accountId,
  periodStart,
  periodEnd,
  initial,
  onSubmit,
  onCancel,
  busy,
}: {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  initial?: Transaction;
  onSubmit: (body: {
    accountId: string;
    date: string;
    description: string;
    amount: number;
    cardLast4?: string;
    installmentNumber?: number | null;
    totalInstallments?: number | null;
  }) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const descRef = useRef<HTMLInputElement>(null);
  // Extract day/month/year from the initial date or default to periodEnd.
  const refDate = initial?.date ?? periodEnd.slice(0, 10);
  const [day, setDay] = useState(String(parseInt(refDate.slice(8, 10), 10)));
  const [month, setMonth] = useState(String(parseInt(refDate.slice(5, 7), 10)));
  const [year, setYear] = useState(refDate.slice(0, 4));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(
    initial ? String(Math.abs(initial.amount)) : '',
  );
  const [cardLast4, setCardLast4] = useState(initial?.cardLast4 ?? '');
  const [installmentNumber, setInstallmentNumber] = useState(
    initial?.installmentNumber != null ? String(initial.installmentNumber) : '',
  );
  const [totalInstallments, setTotalInstallments] = useState(
    initial?.totalInstallments != null ? String(initial.totalInstallments) : '',
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(amount.replace(',', '.'));
    if (!description.trim() || isNaN(parsed) || parsed <= 0) return;
    const d = parseInt(day, 10);
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (
      isNaN(d) ||
      d < 1 ||
      d > 31 ||
      isNaN(m) ||
      m < 1 ||
      m > 12 ||
      isNaN(y) ||
      y < 2000 ||
      y > 2100
    ) return;
    // Installment fields move as a pair: both filled or both empty.
    const iNum = installmentNumber.trim() ? parseInt(installmentNumber, 10) : null;
    const iTot = totalInstallments.trim() ? parseInt(totalInstallments, 10) : null;
    if ((iNum === null) !== (iTot === null)) return;
    if (iNum !== null && iTot !== null && (iNum < 1 || iTot < 1 || iNum > iTot)) return;
    const fullDate = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    onSubmit({
      accountId,
      date: fullDate,
      description: description.trim(),
      amount: parsed,
      cardLast4: cardLast4.trim() || undefined,
      installmentNumber: iNum,
      totalInstallments: iTot,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 border-b border-[color:var(--color-paper-rule)] pb-4"
    >
      <div className="grid grid-cols-[116px_1fr_110px_72px_96px] items-end gap-3">
        <div className="grid grid-cols-[1fr_1fr_2fr] gap-1.5">
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              D
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={day}
              onChange={(e) => setDay(e.target.value.replace(/\D/g, ''))}
              placeholder="15"
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              M
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={month}
              onChange={(e) => setMonth(e.target.value.replace(/\D/g, ''))}
              placeholder="04"
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
              Ano
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))}
              placeholder={periodEnd.slice(0, 4)}
              className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none focus:border-[color:var(--color-accent)]"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Descrição
          </label>
          <input
            ref={descRef}
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Ex: UBER *EATS"
            autoFocus
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-body text-[15px] text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Valor (R$)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-mono text-[15px] tabular-nums text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Cartão
          </label>
          <input
            type="text"
            maxLength={20}
            value={cardLast4}
            onChange={(e) => setCardLast4(e.target.value)}
            placeholder="1234"
            className="w-full border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 font-mono text-xs text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
            Parcela
          </label>
          <div className="flex items-center gap-1">
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={installmentNumber}
              onChange={(e) => setInstallmentNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="3"
              className="w-full min-w-0 border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
            />
            <span className="font-mono text-xs text-[color:var(--color-ink-faint)]">/</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={2}
              value={totalInstallments}
              onChange={(e) => setTotalInstallments(e.target.value.replace(/\D/g, ''))}
              placeholder="10"
              className="w-full min-w-0 border-b border-[color:var(--color-ink-muted)] bg-transparent pb-1 text-center font-mono text-xs text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)]"
            />
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-accent)] hover:text-[color:var(--color-ink)] disabled:opacity-50"
        >
          {initial ? 'salvar' : 'adicionar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-body text-xs uppercase tracking-[0.12em] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
        >
          cancelar
        </button>
      </div>
    </form>
  );
}
