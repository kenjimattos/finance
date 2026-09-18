/**
 * Reconcile a closed-bill statement PDF against the transactions the app has
 * for the same bill window — done by the model, checked by code.
 *
 * The judgment calls all belong to the model: reading a layout that differs by
 * issuer, telling which printed total is the period's net charges (Itaú prints
 * it as "Total dos lançamentos atuais", PicPay as "Total da fatura" next to a
 * gross "Total geral dos lançamentos"), and pairing statement lines with app
 * rows whose descriptions, dates and cents rarely agree verbatim. Encoding any
 * of that as matching heuristics kept breaking on the next statement. What
 * the model can't infer — what an issuer's boxes mean — it is told, as a
 * layout description in the prompt (ISSUER_LAYOUTS), never as code rules.
 *
 * Code only does what the model is bad at or must not be trusted with:
 * arithmetic (row sums, per-pair diffs), bookkeeping (every app row accounted
 * for exactly once, no invented ids) and surfacing whatever failed those
 * checks as warnings. `buildReport` is that half — pure, and unit-tested.
 */
import type OpenAI from 'openai';
import { z } from 'zod';
import { makeClient, secs } from './llm.js';

/** A line as read from the statement. `amount` is signed: credits negative. */
export interface StatementLine {
  /** The line exactly as printed, so the user can audit the reading. */
  quote: string;
  date: string; // yyyy-mm-dd (parceladas keep the original purchase date)
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  /** Model's remark on an unpaired line (Portuguese), if any. */
  note: string | null;
}

export interface AppLine {
  id: string;
  date: string;
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  source: string; // 'pluggy' | 'manual'
  category: string | null;
}

export interface ReconcileContext {
  periodStart: string;
  /** Closing date of the bill (yyyy-mm-dd). */
  periodEnd: string;
  dueDate: string;
  /** Today (yyyy-mm-dd), for year inference. */
  referenceDate: string;
  /** Known issuer, whose statement layout is described to the model. */
  issuer: Issuer | null;
}

// ── Issuer layouts ──────────────────────────────────────────────────────────
//
// What a statement's boxes MEAN is not inferable from their labels: PicPay's
// "Total geral dos lançamentos" reads like the net total and is gross. The app
// knows the issuer, so it tells the model — as a description of the layout,
// never with example values, which models copy into their answer.

export type Issuer = 'picpay' | 'itau';

/**
 * Pluggy's connector name is the aggregator for every account here
 * ("MeuPluggy"), so the issuer comes from the account's product name
 * ("PIC PAY MASTERCARD BLACK", "LATAM PASS ITAU MASTERCARD PLATINUM").
 */
export function issuerFromAccountName(name: string | null): Issuer | null {
  const n = (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (n.includes('PICPAY')) return 'picpay';
  if (n.includes('ITAU')) return 'itau';
  return null;
}

const ISSUER_LAYOUTS: Record<Issuer, string> = {
  picpay: [
    'This is a PicPay statement. Its layout:',
    '- Page 1 has a "Resumo" box with, in order: "Fatura anterior", "Pagamento recebido", "Créditos e estornos" (printed negative), "Despesas do mês", "Total da fatura".',
    '- Transactions are grouped by card: a first "Picpay Card" section with no card number, then one section per card headed "Picpay Card final NNNN". Two sections can sit side by side in two columns on the same page.',
    '- Estornos appear inside the card sections as lines with a negative value. PicPay leaves them OUT of every "Subtotal dos lançamentos", of "Total geral dos lançamentos" and of "Despesas do mês" — those figures are GROSS, charges only — and totals them apart as "Créditos e estornos".',
    '- So the net total is NOT "Total geral dos lançamentos" nor "Despesas do mês". It is "Despesas do mês" plus the negative "Créditos e estornos"; compute it from those two printed figures, and name both in the label.',
    '- "PAGAMENTO DE FATURA" lines are payments of the previous bill, not lançamentos. Installments are marked "PARCxx/yy" glued to the merchant name.',
  ].join('\n'),
  itau: [
    'This is an Itaú statement. Its layout:',
    '- "Total dos lançamentos atuais" is the net total of this period\'s lines (estornos and reduções already subtracted). "Total desta fatura" also carries previous balance and financing charges — not the net total.',
    '- Each transaction line may be followed by a category/city line; that is part of the line above, not a transaction.',
    '- In the international block, the value to record is the R$ amount on the dd/mm merchant line. The lines below it (original amount and currency code, conversion rate) are details of that same purchase, never separate lines or the amount to record — even when the currency code is BRL.',
    '- An IOF pass-through line in the international block is a real charge only if the statement prints it.',
    '- "Lançamentos: produtos e serviços" (anuidade, reduções) are lines of this bill. The "Compras parceladas - próximas faturas" block lists FUTURE installments: not charges of this bill. The "Encargos cobrados nesta fatura" breakdown goes into `encargos`, not into the lines.',
    '- Installments are a trailing "xx/yy" at the end of the merchant text.',
  ].join('\n'),
};

export interface ReconcileReportCore {
  /** The printed net total the model picked, or null if none is printed. */
  statementTotal: number | null;
  /** The label of that figure, copied from the PDF ("Total da fatura"). */
  statementTotalLabel: string | null;
  /** One sentence on why that figure is the net one. */
  statementTotalReasoning: string;
  /** "Total de encargos" when the statement prints one. */
  statementCharges: number | null;
  /** Sum of the lines the model read — computed here, never by the model. */
  statementRowsTotal: number;
  matched: Array<{ statement: StatementLine; app: AppLine }>;
  amountMismatches: Array<{ statement: StatementLine; app: AppLine; diff: number }>;
  missingInApp: StatementLine[];
  onlyInApp: Array<AppLine & { reason: string }>;
  /** Checks the model's answer failed, in Portuguese, for the report. */
  warnings: string[];
}

/** Payment rows live in the transactions table but are not statement lançamentos. */
const PAYMENT_RE = /pagamento\s+(de\s+fatura|recebido)/i;

export function isPaymentLine(description: string | null): boolean {
  return description != null && PAYMENT_RE.test(description);
}

// ── What the model returns ──────────────────────────────────────────────────

// Strict structured output: every property required, nullable instead of
// optional, no extra keys.
const RECONCILIATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['netTotal', 'encargos', 'statementLines', 'onlyInApp'],
  properties: {
    netTotal: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'label', 'reasoning'],
      properties: {
        amount: { type: ['number', 'null'] },
        label: { type: ['string', 'null'] },
        reasoning: { type: 'string' },
      },
    },
    encargos: { type: ['number', 'null'] },
    statementLines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'quote',
          'date',
          'description',
          'amount',
          'cardLast4',
          'installmentNumber',
          'totalInstallments',
          'appRef',
          'note',
        ],
        properties: {
          quote: { type: 'string' },
          date: { type: 'string' },
          description: { type: 'string' },
          amount: { type: 'number' },
          cardLast4: { type: ['string', 'null'] },
          installmentNumber: { type: ['integer', 'null'] },
          totalInstallments: { type: ['integer', 'null'] },
          appRef: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
        },
      },
    },
    onlyInApp: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['appRef', 'reason'],
        properties: {
          appRef: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

const rawSchema = z.object({
  netTotal: z.object({
    amount: z.number().finite().nullable(),
    label: z.string().nullable(),
    reasoning: z.string(),
  }),
  encargos: z.number().finite().nullable(),
  statementLines: z.array(
    z.object({
      quote: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string(),
      amount: z.number().finite(),
      cardLast4: z.string().nullable(),
      installmentNumber: z.number().int().nullable(),
      totalInstallments: z.number().int().nullable(),
      appRef: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  onlyInApp: z.array(z.object({ appRef: z.string(), reason: z.string() })),
});

export type RawReconciliation = z.infer<typeof rawSchema>;

// ── The model's half ────────────────────────────────────────────────────────

/** Short, stable refs for the prompt: cheaper and easier to copy than UUIDs. */
export const appRef = (index: number) => `A${index + 1}`;

function describeAppLines(appLines: AppLine[]): string {
  return appLines
    .map((l, i) =>
      JSON.stringify({
        ref: appRef(i),
        date: l.date,
        description: l.description,
        amount: l.amount,
        card: l.cardLast4,
        installment:
          l.installmentNumber != null && l.totalInstallments != null
            ? `${l.installmentNumber}/${l.totalInstallments}`
            : null,
        source: l.source,
      }),
    )
    .join('\n');
}

function buildPrompt(ctx: ReconcileContext, appLines: AppLine[]): string {
  return [
    'You are reconciling a Brazilian credit-card statement (fatura, the attached PDF) against the transactions a personal-finance app has recorded for the same bill.',
    `The bill cycle runs ${ctx.periodStart} to ${ctx.periodEnd} (closing date), due ${ctx.dueDate}. Today is ${ctx.referenceDate}.`,
    '',
    '1. READ THE STATEMENT. Record every line that is a charge or credit of THIS bill: purchases, installment charges, estornos/credits, and fees the statement itemizes as their own lines. Do not record payments of previous bills, previews of future installments, or any summary figure, subtotal, limit or interest simulation. Record only what is printed — never add a line the statement does not show. For each line:',
    '   - quote: the line exactly as printed;',
    '   - date: yyyy-mm-dd. Statements print dd/mm, day first. Choose the year that puts the date on or before the closing date; installment charges keep their original purchase date, which may be months or a year earlier;',
    '   - amount: in BRL, signed — credits and estornos negative;',
    '   - cardLast4: the last 4 digits of the card whose section the line sits in, or null when that section names no card number;',
    '   - installmentNumber / totalInstallments: from an installment marker such as "PARC03/06" or a trailing "03/06", else null.',
    '',
    '2. FIND THE NET TOTAL. Find the printed figure that equals this period\'s charges minus its credits — the number the lines you recorded should add up to. Statements label it differently and often also print gross figures, or totals that fold in the previous balance, payments or financing charges; choose the one that is the net of this period\'s lines. Copy its value and its exact label, and say in one sentence why it is the net figure. If the statement prints the net only in parts — a gross charges figure and a separate credits figure — compute it from those two printed figures and name both in the label. Never compute it by adding up the lines; use null if the statement prints neither. Also copy the total of financing charges (juros, multa, IOF de financiamento) into `encargos` if printed, else null.',
    '',
    '3. PAIR WITH THE APP. The app\'s rows for this bill are listed below, one JSON object per line. Set a statement line\'s `appRef` to the app row that is the same charge. Expect differences: bank feeds rename merchants and users edit descriptions; dates can differ by a few days, or the app may date an installment by its original purchase or by a billing date; manually entered installments can differ by a few cents. Pair them anyway when it is clearly the same charge. Each app row pairs with at most one statement line. For an unpaired statement line set appRef to null and, if useful, a short `note`. Every app row not paired goes into `onlyInApp` with a short reason (e.g. duplicate of another row, belongs to another cycle, not on the statement). Every app ref must appear exactly once: as some line\'s appRef or in onlyInApp.',
    '',
    ...(ctx.issuer ? [ISSUER_LAYOUTS[ctx.issuer], ''] : []),
    'Write `note`, `reason` and `reasoning` in Portuguese.',
    '',
    '--- APP ROWS ---',
    describeAppLines(appLines) || '(none)',
  ].join('\n');
}

/**
 * Send the statement PDF and the app's rows to the model and return its raw
 * reconciliation. Throws `IMPORT_DISABLED` without a key, or when the model
 * returns no usable answer.
 */
export async function reconcileWithModel(
  pdfBase64: string,
  appLines: AppLine[],
  ctx: ReconcileContext,
): Promise<RawReconciliation> {
  // A reasoning model reading a full statement can take minutes; a retry
  // re-runs all of it, so allow one.
  const { client, model } = makeClient('reconcile', { timeoutMs: 300_000, maxRetries: 1 });
  const content: OpenAI.ChatCompletionContentPart[] = [
    {
      type: 'file',
      file: { filename: 'fatura.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` },
    },
    { type: 'text', text: buildPrompt(ctx, appLines) },
  ];

  const startedAt = Date.now();
  console.log(
    `[reconcile] model start — ${Math.round((pdfBase64.length * 3) / 4 / 1024)}KB pdf, ` +
      `${appLines.length} app row(s), window ${ctx.periodStart}..${ctx.periodEnd}`,
  );
  const completion = await client.chat.completions.create({
    model,
    // Room for ~100 lines with quotes and notes, plus reasoning tokens.
    max_completion_tokens: 32_000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'reconciliation', strict: true, schema: RECONCILIATION_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  });
  const choice = completion.choices[0];
  const u = completion.usage;
  console.log(
    `[reconcile] model took ${secs(startedAt)} — model=${completion.model} ` +
      `in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'} ` +
      `reasoning=${u?.completion_tokens_details?.reasoning_tokens ?? 0} ` +
      `finish=${choice?.finish_reason}`,
  );

  const text = choice?.message.content;
  if (!text) {
    throw new Error(
      `Model returned no reconciliation (finish_reason=${choice?.finish_reason}` +
        (choice?.message.refusal ? `, refusal: ${choice.message.refusal}` : '') +
        ')',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // finish_reason=length lands here: the JSON was cut off.
    throw new Error(`Model returned malformed JSON (finish_reason=${choice.finish_reason})`);
  }
  return rawSchema.parse(json);
}

// ── The code's half: check, don't interpret ─────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn the model's answer into the report, verifying what can be verified:
 * refs must exist and be used once, every app row must be accounted for, and
 * the sums and per-pair diffs are computed here. Anything that fails a check
 * is kept visible (as missing / only-in-app) and explained in `warnings`,
 * never silently dropped.
 */
export function buildReport(raw: RawReconciliation, appLines: AppLine[]): ReconcileReportCore {
  const byRef = new Map(appLines.map((l, i) => [appRef(i), l]));
  const used = new Set<string>();
  const warnings: string[] = [];

  const matched: ReconcileReportCore['matched'] = [];
  const amountMismatches: ReconcileReportCore['amountMismatches'] = [];
  const missingInApp: StatementLine[] = [];

  for (const r of raw.statementLines) {
    const statement: StatementLine = {
      quote: r.quote,
      date: r.date,
      description: r.description.trim(),
      amount: round2(r.amount),
      cardLast4: r.cardLast4?.trim() || null,
      installmentNumber: r.installmentNumber,
      totalInstallments: r.totalInstallments,
      note: r.note,
    };
    if (r.appRef == null) {
      missingInApp.push(statement);
      continue;
    }
    const app = byRef.get(r.appRef);
    if (!app) {
      warnings.push(`A IA pareou "${r.quote}" com ${r.appRef}, que não existe; tratada como ausente no app.`);
      missingInApp.push(statement);
      continue;
    }
    if (used.has(r.appRef)) {
      warnings.push(`A IA pareou "${r.quote}" com ${r.appRef}, já usada por outra linha; tratada como ausente no app.`);
      missingInApp.push(statement);
      continue;
    }
    used.add(r.appRef);
    const diff = round2(statement.amount - app.amount);
    if (Math.abs(diff) < 0.005) matched.push({ statement, app });
    else amountMismatches.push({ statement, app, diff });
  }

  const onlyInApp: ReconcileReportCore['onlyInApp'] = [];
  for (const o of raw.onlyInApp) {
    const app = byRef.get(o.appRef);
    if (!app) {
      warnings.push(`A IA citou ${o.appRef} como só no app, mas essa linha não existe.`);
      continue;
    }
    if (used.has(o.appRef)) {
      warnings.push(`A IA citou ${o.appRef} como só no app, mas também a pareou com a fatura; mantido o pareamento.`);
      continue;
    }
    used.add(o.appRef);
    onlyInApp.push({ ...app, reason: o.reason });
  }

  // The model must account for every app row; one it skipped is still an app
  // row the statement doesn't explain, so it is listed, flagged.
  let skipped = 0;
  appLines.forEach((app, i) => {
    if (used.has(appRef(i))) return;
    skipped++;
    onlyInApp.push({ ...app, reason: 'Não analisada pela IA.' });
  });
  if (skipped > 0) {
    warnings.push(
      `A IA não analisou ${skipped} ${skipped === 1 ? 'linha' : 'linhas'} do app; ${skipped === 1 ? 'ela aparece' : 'elas aparecem'} em "só no app".`,
    );
  }

  const statementRowsTotal = round2(raw.statementLines.reduce((s, r) => s + r.amount, 0));
  const statementTotal = raw.netTotal.amount == null ? null : round2(raw.netTotal.amount);
  if (statementTotal != null && Math.abs(statementTotal - statementRowsTotal) >= 0.01) {
    warnings.push(
      `As linhas lidas somam ${brl(statementRowsTotal)}, mas o total impresso escolhido é ${brl(statementTotal)} ` +
        `(diferença de ${brl(round2(statementTotal - statementRowsTotal))}). Alguma linha foi lida errado ou ficou de fora.`,
    );
  }

  return {
    statementTotal,
    statementTotalLabel: raw.netTotal.label,
    statementTotalReasoning: raw.netTotal.reasoning,
    statementCharges: raw.encargos,
    statementRowsTotal,
    matched,
    amountMismatches,
    missingInApp,
    onlyInApp,
    warnings,
  };
}

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
