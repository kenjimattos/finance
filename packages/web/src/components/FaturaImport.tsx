import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ExtractedFaturaRow, type CommitFaturaRow } from '../lib/api';
import { useToast } from './Toast';

/**
 * Upload fatura screenshots → Claude extracts the lines → editable review →
 * insert as manual transactions. The import is contextual to the bill the user
 * is viewing (`billOffset`): each row carries the bill_shift needed to land it
 * in that bill, so an edge-of-cycle purchase (e.g. 17/06 on the bill that
 * closed 16/06) is pulled in automatically.
 */

const MAX_DIM = 1568; // Claude's optimal long edge; keeps payload + cost down.

/** Downscale an image file and return base64 JPEG (no data: prefix). */
async function fileToDownscaled(file: File): Promise<{ data: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas indisponível');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { data: dataUrl.split(',')[1] ?? '', mediaType: 'image/jpeg' };
}

interface EditableRow {
  include: boolean;
  date: string;
  description: string;
  magnitude: number;
  isRefund: boolean;
  cardLast4: string;
  installmentNumber: number | null;
  totalInstallments: number | null;
  naturalShift: number;
  applyShift: boolean;
}

function toEditable(r: ExtractedFaturaRow): EditableRow {
  return {
    include: true,
    date: r.date,
    description: r.description,
    magnitude: Math.abs(r.amount),
    isRefund: r.isRefund,
    cardLast4: r.cardLast4 ?? '',
    installmentNumber: r.installmentNumber,
    totalInstallments: r.totalInstallments,
    naturalShift: r.billShift,
    applyShift: r.billShift !== 0,
  };
}

function toCommit(r: EditableRow): CommitFaturaRow {
  return {
    date: r.date,
    description: r.description.trim(),
    amount: (r.isRefund ? -1 : 1) * Math.abs(r.magnitude),
    cardLast4: r.cardLast4.trim() === '' ? null : r.cardLast4.trim(),
    installmentNumber: r.installmentNumber,
    totalInstallments: r.totalInstallments,
    billShift: r.applyShift ? r.naturalShift : 0,
  };
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function FaturaImport({
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

  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [rows, setRows] = useState<EditableRow[] | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Object URLs for thumbnails; revoke on change/unmount.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const extractM = useMutation({
    mutationFn: async () => {
      const images = await Promise.all(files.map(fileToDownscaled));
      return api.extractFatura({ accountId, billOffset, images });
    },
    onSuccess: (res) => {
      setRows(res.rows.map(toEditable));
      if (res.rows.length === 0) {
        toast.show({ message: 'Nenhuma transação encontrada nos screenshots.' });
      }
    },
    onError: (err) => {
      let msg = 'Falha ao ler os screenshots. Tente novamente.';
      if (err instanceof ApiError && err.status === 503) {
        msg = 'Importação não configurada no servidor.';
      } else if (err instanceof ApiError && err.status === 429) {
        msg = 'Provedor de visão ocupado. Tente de novo em alguns segundos.';
      }
      toast.show({ message: msg });
    },
  });

  const commitM = useMutation({
    mutationFn: async (toInsert: CommitFaturaRow[]) =>
      api.commitFaturaImport({ accountId, rows: toInsert }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['billBreakdown', itemId] });
      queryClient.invalidateQueries({ queryKey: ['splitSummary', accountId] });
      queryClient.invalidateQueries({ queryKey: ['transactions', itemId] });
      toast.show({ message: `${res.count} ${res.count === 1 ? 'transação inserida' : 'transações inseridas'}.` });
      onClose();
    },
    onError: () => toast.show({ message: 'Falha ao inserir as transações.' }),
  });

  function patch(i: number, p: Partial<EditableRow>) {
    setRows((prev) => prev && prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  }

  const included = rows?.filter((r) => r.include) ?? [];
  const includedTotal = included.reduce((s, r) => s + (r.isRefund ? -1 : 1) * Math.abs(r.magnitude), 0);

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

        <div className="eyebrow mb-2">Importar fatura</div>
        <h2 className="font-display text-3xl leading-tight tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
          Screenshots → transações
        </h2>
        <p className="mt-3 max-w-[58ch] font-body text-sm text-[color:var(--color-ink-muted)]">
          Suba os prints da fatura do app do cartão. A leitura é automática; você
          revisa e ajusta antes de inserir. Lançamentos fora do ciclo entram nesta
          fatura automaticamente.
        </p>

        {!rows && (
          <div className="mt-6">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="border border-dashed border-[color:var(--color-ink)] px-4 py-3 font-mono text-sm text-[color:var(--color-ink)] hover:bg-[color:var(--color-paper-tint)]"
            >
              {files.length ? `${files.length} imagem(ns) selecionada(s) — trocar` : 'Escolher screenshots'}
            </button>

            {previews.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {previews.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt={`print ${i + 1}`}
                    className="h-24 w-auto border border-[color:var(--color-ink)]/30 object-cover"
                  />
                ))}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                disabled={files.length === 0 || extractM.isPending}
                onClick={() => extractM.mutate()}
                className="bg-[color:var(--color-accent)] px-5 py-2 font-mono text-sm text-[color:var(--color-paper)] disabled:opacity-40"
              >
                {extractM.isPending ? 'Lendo…' : 'Extrair'}
              </button>
            </div>
          </div>
        )}

        {rows && (
          <div className="mt-6">
            <div className="mb-3 flex items-baseline justify-between">
              <div className="eyebrow">{included.length} de {rows.length} para inserir</div>
              <div className="font-mono text-sm text-[color:var(--color-ink)]">{BRL.format(includedTotal)}</div>
            </div>

            <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
              {rows.map((r, i) => (
                <div
                  key={i}
                  className={`border p-3 ${r.include ? 'border-[color:var(--color-ink)]/30' : 'border-[color:var(--color-ink)]/10 opacity-45'}`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => patch(i, { include: e.target.checked })}
                      className="mt-1"
                    />
                    <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                      <input
                        type="date"
                        value={r.date}
                        onChange={(e) => patch(i, { date: e.target.value })}
                        className="col-span-1 border border-[color:var(--color-ink)]/20 bg-transparent px-2 py-1 font-mono text-xs"
                      />
                      <input
                        type="text"
                        value={r.description}
                        onChange={(e) => patch(i, { description: e.target.value })}
                        placeholder="descrição"
                        className="col-span-2 border border-[color:var(--color-ink)]/20 bg-transparent px-2 py-1 font-body text-sm sm:col-span-2"
                      />
                      <input
                        type="text"
                        inputMode="text"
                        value={r.cardLast4}
                        onChange={(e) => patch(i, { cardLast4: e.target.value })}
                        placeholder="cartão"
                        className="col-span-1 border border-[color:var(--color-ink)]/20 bg-transparent px-2 py-1 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3 pl-7">
                    <label className="flex items-center gap-1 font-mono text-xs text-[color:var(--color-ink-muted)]">
                      R$
                      <input
                        type="number"
                        step="0.01"
                        value={r.magnitude}
                        onChange={(e) => patch(i, { magnitude: Number(e.target.value) })}
                        className="w-24 border border-[color:var(--color-ink)]/20 bg-transparent px-2 py-1 text-right font-mono text-sm"
                      />
                    </label>
                    <label className="flex items-center gap-1 font-mono text-xs text-[color:var(--color-ink-muted)]">
                      <input
                        type="checkbox"
                        checked={r.isRefund}
                        onChange={(e) => patch(i, { isRefund: e.target.checked })}
                      />
                      estorno
                    </label>
                    <label className="flex items-center gap-1 font-mono text-xs text-[color:var(--color-ink-muted)]">
                      parc.
                      <input
                        type="number"
                        min="1"
                        value={r.installmentNumber ?? ''}
                        onChange={(e) =>
                          patch(i, { installmentNumber: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        className="w-12 border border-[color:var(--color-ink)]/20 bg-transparent px-1 py-1 text-right font-mono text-xs"
                      />
                      /
                      <input
                        type="number"
                        min="1"
                        value={r.totalInstallments ?? ''}
                        onChange={(e) =>
                          patch(i, { totalInstallments: e.target.value === '' ? null : Number(e.target.value) })
                        }
                        className="w-12 border border-[color:var(--color-ink)]/20 bg-transparent px-1 py-1 text-right font-mono text-xs"
                      />
                    </label>
                    {r.naturalShift !== 0 && (
                      <label className="flex items-center gap-1 font-mono text-xs text-[color:var(--color-accent)]">
                        <input
                          type="checkbox"
                          checked={r.applyShift}
                          onChange={(e) => patch(i, { applyShift: e.target.checked })}
                        />
                        nesta fatura (shift {r.naturalShift > 0 ? `+${r.naturalShift}` : r.naturalShift})
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setRows(null)}
                className="font-mono text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
              >
                ← voltar
              </button>
              <button
                type="button"
                disabled={included.length === 0 || commitM.isPending}
                onClick={() => commitM.mutate(included.map(toCommit))}
                className="bg-[color:var(--color-accent)] px-5 py-2 font-mono text-sm text-[color:var(--color-paper)] disabled:opacity-40"
              >
                {commitM.isPending ? 'Inserindo…' : `Inserir ${included.length}`}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
