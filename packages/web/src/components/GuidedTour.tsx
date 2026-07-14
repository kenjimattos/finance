import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';

export interface TourStep {
  /** CSS selector for the element to spotlight; null renders a centered card. */
  target: string | null;
  title: string;
  body: string;
}

/** First-visit walkthrough of the Overview screen. */
export const overviewTourSteps: TourStep[] = [
  {
    target: null,
    title: 'Bem-vindo',
    body: 'Este é o painel do mês: o caixa e as faturas de cartão num lugar só. Um tour de 30 segundos mostra onde tudo mora.',
  },
  {
    target: '[data-tour="month-nav"]',
    title: 'Navegue pelos meses',
    body: 'As setas trocam o mês de vencimento — caixa, faturas e divisão acompanham juntos.',
  },
  {
    target: '[data-tour="caixa"]',
    title: 'Caixa',
    body: 'Saldo da conta corrente, entradas e saídas do mês. Em "ver extrato →" você abre o fluxo de caixa dia a dia, incluindo projeções dos meses futuros.',
  },
  {
    target: '[data-tour="cartoes"]',
    title: 'Cartões',
    body: 'Cada cartão mostra a fatura que vence neste mês. Clique para abrir o detalhamento: categorize os gastos com suas próprias categorias — o sistema aprende e passa a aplicar sozinho nas próximas compras.',
  },
  {
    target: '[data-tour="split"]',
    title: 'Divisão',
    body: 'Para gastos compartilhados: marque lançamentos como ½ ou da outra pessoa dentro da fatura, e aqui aparece o total que cada um deve no mês.',
  },
];

const PAD = 12;
const CARD_W = 340;
const CARD_EST_H = 230;

function tooltipStyle(rect: DOMRect): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(16, rect.left), Math.max(16, vw - CARD_W - 16));
  if (rect.bottom + PAD + CARD_EST_H < vh) {
    return { top: rect.bottom + PAD + 8, left };
  }
  if (rect.top - PAD - CARD_EST_H > 0) {
    return { top: rect.top - PAD - 8, left, transform: 'translateY(-100%)' };
  }
  return { bottom: 16, left };
}

export function GuidedTour({
  steps,
  onClose,
}: {
  steps: TourStep[];
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[index];

  // Advance/retreat, skipping steps whose anchor isn't in the DOM
  // (conditional sections, data still loading).
  const go = useCallback(
    (dir: 1 | -1) => {
      let i = index + dir;
      while (i >= 0 && i < steps.length) {
        const s = steps[i];
        if (!s.target || document.querySelector(s.target)) break;
        i += dir;
      }
      if (i < 0) return;
      if (i >= steps.length) {
        onClose();
        return;
      }
      setIndex(i);
    },
    [index, steps, onClose],
  );

  useEffect(() => {
    if (!step?.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(step.target);
    if (!el) {
      setRect(null);
      return;
    }
    const update = () => setRect(el.getBoundingClientRect());
    update();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const spotlighted = step?.target != null && rect != null;
  const last = index === steps.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* Click shield — blocks interaction with the page during the tour */}
      <div className="absolute inset-0" aria-hidden="true" />

      {/* Dim layer: full when centered, cut out around the target when spotlighting */}
      {spotlighted ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-lg transition-all duration-300 ease-out"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 100vmax rgba(12, 9, 7, 0.6)',
          }}
        />
      ) : (
        <div
          aria-hidden="true"
          className="fixed inset-0"
          style={{ background: 'rgba(12, 9, 7, 0.6)' }}
        />
      )}

      {/* Tooltip / welcome card */}
      <div
        className={spotlighted ? 'fixed' : 'fixed inset-0 flex items-center justify-center p-4'}
        style={spotlighted ? tooltipStyle(rect) : undefined}
        role="dialog"
        aria-label={step.title}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="w-[340px] max-w-[calc(100vw-32px)] border border-[color:var(--color-paper-rule)] bg-[color:var(--color-paper)] p-5"
          >
            <div className="eyebrow mb-2 text-[color:var(--color-accent)]">
              tour · {index + 1}/{steps.length}
            </div>
            <h3 className="font-display text-2xl leading-tight tracking-[-0.02em] text-[color:var(--color-ink)]">
              {step.title}
            </h3>
            <p className="mt-2 font-body text-sm leading-relaxed text-[color:var(--color-ink-muted)]">
              {step.body}
            </p>
            <div className="mt-5 flex items-center justify-between">
              <button
                type="button"
                onClick={onClose}
                className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-ink)]"
              >
                pular
              </button>
              <div className="flex items-center gap-4">
                {index > 0 && (
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    aria-label="passo anterior"
                    className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
                  >
                    ←
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => go(1)}
                  className="font-body text-xs uppercase tracking-[0.14em] text-[color:var(--color-accent)] transition-colors hover:text-[color:var(--color-ink)]"
                >
                  {last ? 'entendi' : index === 0 ? 'começar →' : 'próximo →'}
                </button>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>,
    document.body,
  );
}
