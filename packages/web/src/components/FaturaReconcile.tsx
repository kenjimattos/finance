import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ReconcileReport,
  type ReconcileMissingRow,
} from '../lib/api';
import { useToast } from './Toast';

/**
 * Upload the issuer's closed-bill PDF → the API extracts its lines and diffs
 * them against the bill being viewed → the user applies the fixes:
 *   - insert statement lines missing from the app (as manual transactions)
 *   - fix cent drift on manual installment rows
 * "Só no app" rows are informational (duplicates / cycle differences).
 */

const MAX_PDF_BYTES = 20 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function fmtDate(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${d}/${m}`;
}

export function FaturaReconcile({
  itemId,
  accountId,
  billOffset,
  onClose,
}: {
  itemId: string;
  accountId: string;
  billOffset: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function invalidateBill() {
    queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
    queryClient.invalidateQueries({ queryKey: ['splitSummary', accountId] });
    queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
  }

  const reconcileM = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      if (file.size > MAX_PDF_BYTES) throw new Error('PDF_TOO_LARGE');
      const pdf = await fileToBase64(file);
      return api.reconcileFatura({ accountId, billOffset, pdf });
    },
    onSuccess: (res) => {
      setReport(res);
      setSelected(new Set(res.missingInApp.map((_, i) => i)));
    },
    onError: (err) => {
      let msg = 'Falha ao ler o PDF. Tente novamente.';
      if (err instanceof Error && err.message === 'PDF_TOO_LARGE') {
        msg = 'PDF acima de 20MB.';
      } else if (err instanceof ApiError && err.status === 503) {
        msg = 'Conciliação não configurada no servidor.';
      } else if (err instanceof ApiError && err.status === 422) {
        msg = 'PDF sem texto extraível (escaneado?). Use a importação por screenshots.';
      } else if (err instanceof ApiError && err.status === 429) {
        msg = 'Provedor de IA ocupado. Tente de novo em alguns segundos.';
      }
      toast.show({ message: msg });
    },
  });

  const insertM = useMutation({
    mutationFn: async (rows: ReconcileMissingRow[]) =>
      api.commitFaturaImport({
        accountId,
        rows: rows.map((r) => ({
          date: r.date,
          description: r.description,
          amount: r.amount,
          cardLast4: r.cardLast4,
          installmentNumber: r.installmentNumber,
          totalInstallments: r.totalInstallments,
          billShift: r.billShift,
        })),
      }),
    onSuccess: (res, rows) => {
      invalidateBill();
      setReport((prev) =>
        prev && {
          ...prev,
          missingInApp: prev.missingInApp.filter((r) => !rows.includes(r)),
          matchedCount: prev.matchedCount + rows.length,
        },
      );
      setSelected(new Set());
      toast.show({
        message: `${res.count} ${res.count === 1 ? 'transação inserida' : 'transações inseridas'} — categorize no inbox para somarem na fatura.`,
      });
    },
    onError: () => toast.show({ message: 'Falha ao inserir as transações.' }),
  });

  const fixM = useMutation({
    mutationFn: async (fixes: Array<{ id: string; amount: number }>) => {
      for (const f of fixes) {
        await api.updateManualTransaction(f.id, { amount: f.amount });
      }
      return fixes.length;
    },
    onSuccess: (count, fixes) => {
      invalidateBill();
      const fixedIds = new Set(fixes.map((f) => f.id));
      setReport((prev) =>
        prev && {
          ...prev,
          amountMismatches: prev.amountMismatches.filter((m) => !fixedIds.has(m.app.id)),
          matchedCount: prev.matchedCount + count,
        },
      );
      toast.show({ message: `${count} ${count === 1 ? 'valor corrigido' : 'valores corrigidos'}.` });
    },
    onError: () => toast.show({ message: 'Falha ao corrigir os valores.' }),
  });

  const missing = report?.missingInApp ?? [];
  const selectedRows = missing.filter((_, i) => selected.has(i));
  const manualMismatches = (report?.amountMismatches ?? []).filter((m) => m.app.source === 'manual');
  const deltaOk = report != null && Math.abs(report.delta) < 0.005;
  const gapOff = report != null && Math.abs(report.extractionGap) >= 0.01;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[900] flex items-start justify-center overflow-y-auto bg-[color:var(--color-ink)]/40 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] }}
        className="relative my-8 w-full max-w-[760px] border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] p-6 shadow-[8px_8px_0_0_var(--color-ink)] sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-4 top-4 font-mono text-lg text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
        >
          ✕
        </button>

        <div className="eyebrow mb-2">Conciliar fatura</div>
        <h2 className="font-display text-3xl leading-tight tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
          PDF × app
        </h2>
        <p className="mt-3 max-w-[58ch] font-body text-sm text-[color:var(--color-ink-muted)]">
          Suba o PDF da fatura fechada do emissor. As linhas são comparadas com o
          que o app tem nesta fatura: o que falta pode ser inserido, e diferenças
          de centavos em parcelas podem ser corrigidas.
        </p>

        {!report && (
          <div className="mt-6">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="border border-dashed border-[color:var(--color-ink)] px-4 py-3 font-mono text-sm text-[color:var(--color-ink)] hover:bg-[color:var(--color-paper-tint)]"
            >
              {file ? `${file.name} — trocar` : 'Escolher PDF da fatura'}
            </button>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                disabled={!file || reconcileM.isPending}
                onClick={() => reconcileM.mutate()}
                className="bg-[color:var(--color-accent)] px-5 py-2 font-mono text-sm text-[color:var(--color-paper)] disabled:opacity-40"
              >
                {reconcileM.isPending ? 'Comparando…' : 'Comparar'}
              </button>
            </div>
          </div>
        )}

        {report && (
          <div className="mt-6 space-y-6">
            {/* Totais */}
            <div className="border border-[color:var(--color-ink)]/30 p-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="eyebrow">fatura (pdf)</div>
                  <div className="font-mono text-sm text-[color:var(--color-ink)]">{BRL.format(report.statementTotal)}</div>
                </div>
                <div>
                  <div className="eyebrow">app</div>
                  <div className="font-mono text-sm text-[color:var(--color-ink)]">{BRL.format(report.appBillTotal)}</div>
                </div>
                <div>
                  <div className="eyebrow">diferença</div>
                  <div className={`font-mono text-sm ${deltaOk ? 'text-[color:var(--color-ink-muted)]' : 'text-[color:var(--color-accent)]'}`}>
                    {deltaOk ? '✓ bate' : BRL.format(report.delta)}
                  </div>
                </div>
              </div>

              {/* O total vem do resumo impresso no PDF. Se as linhas lidas não
                  somam esse valor, a leitura perdeu algo — avisar, porque as
                  listas abaixo ficam incompletas na mesma medida. */}
              {gapOff && (
                <p className="mt-3 border-t border-[color:var(--color-ink)]/15 pt-2 font-body text-xs text-[color:var(--color-accent)]">
                  As linhas lidas somam {BRL.format(report.statementRowsTotal)} —{' '}
                  {BRL.format(Math.abs(report.extractionGap))}{' '}
                  {report.extractionGap > 0 ? 'a menos que' : 'a mais que'} o total impresso na
                  fatura. Alguma linha do PDF não foi lida corretamente; as listas abaixo podem
                  estar incompletas.
                </p>
              )}
              {report.statementTotalSource === 'rows' && (
                <p className="mt-3 border-t border-[color:var(--color-ink)]/15 pt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
                  O PDF não traz um total de lançamentos — o valor acima é a soma das linhas lidas.
                </p>
              )}
              {report.statementCharges != null && report.statementCharges !== 0 && (
                <p className="mt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
                  Fora dos lançamentos, a fatura cobra {BRL.format(report.statementCharges)} de
                  encargos
                  {report.statementBillTotal != null &&
                    ` (total desta fatura: ${BRL.format(report.statementBillTotal)})`}
                  .
                </p>
              )}
            </div>

            {/* Faltando no app */}
            {missing.length > 0 && (
              <section>
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="eyebrow">faltando no app ({missing.length})</div>
                  <button
                    type="button"
                    disabled={selectedRows.length === 0 || insertM.isPending}
                    onClick={() => insertM.mutate(selectedRows)}
                    className="bg-[color:var(--color-accent)] px-4 py-1.5 font-mono text-xs text-[color:var(--color-paper)] disabled:opacity-40"
                  >
                    {insertM.isPending ? 'Inserindo…' : `Inserir ${selectedRows.length}`}
                  </button>
                </div>
                <div className="max-h-[30vh] space-y-1 overflow-y-auto pr-1">
                  {missing.map((r, i) => (
                    <label
                      key={`${r.statementDate}-${r.description}-${r.amount}-${i}`}
                      className="flex cursor-pointer items-center gap-3 border border-[color:var(--color-ink)]/20 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(i);
                            else next.delete(i);
                            return next;
                          });
                        }}
                      />
                      <span className="w-12 shrink-0 font-mono text-xs text-[color:var(--color-ink-muted)]">{fmtDate(r.statementDate)}</span>
                      <span className="min-w-0 flex-1 truncate font-body text-sm text-[color:var(--color-ink)]">
                        {r.description}
                        {r.installmentNumber != null && (
                          <span className="ml-1 font-mono text-xs text-[color:var(--color-ink-muted)]">
                            {r.installmentNumber}/{r.totalInstallments}
                          </span>
                        )}
                      </span>
                      {r.cardLast4 && (
                        <span className="font-mono text-xs text-[color:var(--color-ink-muted)]">·{r.cardLast4}</span>
                      )}
                      <span className={`font-mono text-sm ${r.amount < 0 ? 'text-[color:var(--color-positive,green)]' : 'text-[color:var(--color-ink)]'}`}>
                        {BRL.format(r.amount)}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
                  Inseridas entram sem categoria — categorize no inbox para somarem na fatura.
                </p>
              </section>
            )}

            {/* Centavos divergentes */}
            {report.amountMismatches.length > 0 && (
              <section>
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="eyebrow">centavos divergentes ({report.amountMismatches.length})</div>
                  <button
                    type="button"
                    disabled={manualMismatches.length === 0 || fixM.isPending}
                    onClick={() =>
                      fixM.mutate(manualMismatches.map((m) => ({ id: m.app.id, amount: m.statement.amount })))
                    }
                    className="border border-[color:var(--color-ink)] px-4 py-1.5 font-mono text-xs text-[color:var(--color-ink)] hover:bg-[color:var(--color-paper-tint)] disabled:opacity-40"
                  >
                    {fixM.isPending ? 'Corrigindo…' : `Corrigir ${manualMismatches.length}`}
                  </button>
                </div>
                <div className="max-h-[24vh] space-y-1 overflow-y-auto pr-1">
                  {report.amountMismatches.map((m) => (
                    <div
                      key={m.app.id}
                      className="flex items-center gap-3 border border-[color:var(--color-ink)]/20 px-3 py-2"
                    >
                      <span className="w-12 shrink-0 font-mono text-xs text-[color:var(--color-ink-muted)]">{fmtDate(m.app.date)}</span>
                      <span className="min-w-0 flex-1 truncate font-body text-sm text-[color:var(--color-ink)]">
                        {m.app.description}
                        {m.app.installmentNumber != null && (
                          <span className="ml-1 font-mono text-xs text-[color:var(--color-ink-muted)]">
                            {m.app.installmentNumber}/{m.app.totalInstallments}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-xs text-[color:var(--color-ink-muted)]">
                        {BRL.format(m.app.amount)} → {BRL.format(m.statement.amount)}
                      </span>
                      {m.app.source !== 'manual' && (
                        <span className="font-mono text-[10px] uppercase text-[color:var(--color-ink-muted)]">pluggy</span>
                      )}
                    </div>
                  ))}
                </div>
                {report.amountMismatches.some((m) => m.app.source !== 'manual') && (
                  <p className="mt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
                    Linhas do Pluggy não são editáveis — a divergência é só informativa.
                  </p>
                )}
              </section>
            )}

            {/* Só no app */}
            {report.onlyInApp.length > 0 && (
              <section>
                <div className="eyebrow mb-2">só no app ({report.onlyInApp.length})</div>
                <div className="max-h-[20vh] space-y-1 overflow-y-auto pr-1">
                  {report.onlyInApp.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center gap-3 border border-[color:var(--color-ink)]/10 px-3 py-2 opacity-70"
                    >
                      <span className="w-12 shrink-0 font-mono text-xs text-[color:var(--color-ink-muted)]">{fmtDate(l.date)}</span>
                      <span className="min-w-0 flex-1 truncate font-body text-sm text-[color:var(--color-ink)]">{l.description}</span>
                      <span className="font-mono text-[10px] uppercase text-[color:var(--color-ink-muted)]">{l.source}</span>
                      <span className="font-mono text-sm text-[color:var(--color-ink)]">{BRL.format(l.amount)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 font-body text-xs text-[color:var(--color-ink-muted)]">
                  Estão no app mas não no PDF — confira se são duplicadas ou de outro ciclo.
                </p>
              </section>
            )}

            <div className="flex items-center justify-between">
              <div className="font-mono text-xs text-[color:var(--color-ink-muted)]">
                {report.matchedCount} {report.matchedCount === 1 ? 'linha confere' : 'linhas conferem'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setReport(null);
                  setFile(null);
                }}
                className="font-mono text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
              >
                ← outro PDF
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
