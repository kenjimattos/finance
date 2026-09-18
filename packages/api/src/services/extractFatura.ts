/**
 * Extract credit-card transactions from fatura screenshots (vision) or from the
 * text of a statement PDF, using an OpenAI-compatible chat model.
 *
 * Pluggy does not expose open-bill transactions, and even closed bills can miss
 * rows. This service lets the user photograph the issuer's app statement; the
 * model reads each line and returns structured transactions, which the import
 * route then inserts as `source='manual'`.
 *
 * The client speaks the OpenAI Chat Completions format, so it works against
 * OpenAI directly or any compatible gateway (OpenRouter) via OPENAI_BASE_URL.
 *
 * The model calls are isolated behind `extractFaturaFromImages` and
 * `extractFaturaFromPdfText`. The parsing and sign/installment normalization
 * live in the pure `normalizeExtraction`, which is unit-tested without any
 * network.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';

export interface FaturaImage {
  /** base64-encoded image bytes (no data: prefix). */
  data: string;
  /** e.g. 'image/png', 'image/jpeg', 'image/webp'. */
  mediaType: string;
}

export interface ExtractContext {
  /** Inclusive bill window the user is importing into (yyyy-mm-dd). */
  periodStart: string;
  periodEnd: string;
  /** Today, for year inference. */
  referenceDate: string;
}

/** A transaction ready to become a manual row. `amount` is signed: refunds negative. */
export interface ExtractedRow {
  date: string;
  description: string;
  amount: number;
  cardLast4: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  /** Echoed for the UI so the review table can badge estornos. */
  isRefund: boolean;
}

export function isImportEnabled(): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

/**
 * Totals as PRINTED in the statement's own summary box.
 *
 * The reconciliation total used to be reconstructed by summing the extracted
 * lines, which silently reports a wrong "fatura (pdf)" whenever the extraction
 * misses a line. Reading the issuer's own totals gives an independent anchor:
 * if the lines don't sum to it, the gap is surfaced instead of hidden.
 */
export interface StatementTotals {
  /** "Total dos lançamentos atuais" / "Total dos lançamentos" — the period's charges. */
  lancamentos: number | null;
  /** "Total de encargos" (juros, multa, IOF de financiamento), when charged. */
  encargos: number | null;
  /** "Total desta fatura" — what is actually due (lançamentos + encargos + saldo). */
  totalFatura: number | null;
}

const TOOL_NAME = 'record_transactions';

// The tool the model is forced to call. Amounts come back as a POSITIVE
// magnitude plus an `isRefund` flag; normalizeExtraction applies the sign.
//
// `strict: true` makes OpenAI constrain decoding to this schema, which in turn
// requires every property to be listed in `required` and
// `additionalProperties: false` on every object — optional fields are expressed
// as nullable types instead.
const RECORD_TOOL: OpenAI.ChatCompletionFunctionTool = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Record every purchase/charge line read from the credit-card fatura, plus the totals printed in its summary box.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        totals: {
          type: 'object',
          additionalProperties: false,
          description:
            'Totals copied verbatim from the statement summary. Only for PDFs that print them; null each field otherwise.',
          required: ['lancamentos', 'encargos', 'totalFatura'],
          properties: {
            lancamentos: {
              type: ['number', 'null'],
              description:
                '"Total dos lançamentos atuais" / "Total dos lançamentos" as a positive number, or null if the statement does not print it.',
            },
            encargos: {
              type: ['number', 'null'],
              description: '"Total de encargos em R$" (juros/multa/IOF de financiamento), or null.',
            },
            totalFatura: {
              type: ['number', 'null'],
              description: '"Total desta fatura" / "O total da sua fatura é", or null.',
            },
          },
        },
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              date: {
                type: 'string',
                description: 'Transaction date as yyyy-mm-dd. Infer the year from context.',
              },
              description: {
                type: 'string',
                description: 'Merchant/description exactly as shown.',
              },
              amount: {
                type: 'number',
                description:
                  'Positive magnitude in BRL. "R$ 1.234,56" → 1234.56. Never negative.',
              },
              isRefund: {
                type: 'boolean',
                description:
                  'true when the value is shown in green (estorno/refund/credit), else false.',
              },
              cardLast4: {
                type: ['string', 'null'],
                description:
                  'Last 4 digits of the card on the line (e.g. "3047" from "Cartão Adriely 3047"), or null if not shown.',
              },
              installmentNumber: {
                type: ['integer', 'null'],
                description: 'Current installment from "Parcela X de Y" (the X), or null.',
              },
              totalInstallments: {
                type: ['integer', 'null'],
                description: 'Total installments from "Parcela X de Y" (the Y), or null.',
              },
            },
            required: [
              'date',
              'description',
              'amount',
              'isRefund',
              'cardLast4',
              'installmentNumber',
              'totalInstallments',
            ],
          },
        },
      },
      required: ['totals', 'transactions'],
    },
  },
};

function buildPrompt(ctx: ExtractContext): string {
  return [
    'You are reading screenshots of a Brazilian credit-card statement (fatura) from the issuer app (e.g. PicPay/Nubank).',
    'Extract EVERY transaction line into the record_transactions tool. Rules:',
    '',
    `- Dates: the app groups lines under day headers like "13 de Maio". Convert to yyyy-mm-dd. The bill being imported covers ${ctx.periodStart} to ${ctx.periodEnd} (today is ${ctx.referenceDate}); infer the year so each date is realistic for this window. Months can span two calendar years.`,
    '- Amounts: parse Brazilian format. "R$ 1.234,56" → 1234.56. Always return a positive magnitude in `amount`.',
    '- Estornos/refunds: lines whose value is GREEN (often with a ↩/back arrow icon) are refunds. Set isRefund=true and still put the positive magnitude in `amount`.',
    '- Installments: "Parcela 2 de 3" → installmentNumber=2, totalInstallments=3. If the line is not parcelada, both null.',
    '- Card: take the last 4 digits from the subtitle "Cartão … 3047" / "Cartão fisico 3021" / "Cartão virtual 3054". If no card subtitle is visible, use null.',
    '- SKIP payment lines: "Pagamento de Fatura", "Pagamento recebido", "Pagamento" — these are bill payments, not purchases. Do not record them.',
    '- The screenshots may overlap at the top/bottom (the user scrolled). If the SAME line (same day + same description + same amount) appears at the seam between two images, record it only once. But genuine same-day repeats within a single screenshot (e.g. two "Nowigo" of R$ 10,00) are distinct — keep both.',
    '- Preserve the description text as shown, including truncation.',
    '',
    'Call the tool exactly once with all transactions in statement order (newest first is fine).',
  ].join('\n');
}

// Zod mirror of the tool's per-row output for defensive validation.
const rawRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1),
  amount: z.number().finite(),
  isRefund: z.boolean(),
  cardLast4: z.string().nullable(),
  installmentNumber: z.number().int().nullable(),
  totalInstallments: z.number().int().nullable(),
});

const rawTotalsSchema = z
  .object({
    lancamentos: z.number().finite().nullable().optional(),
    encargos: z.number().finite().nullable().optional(),
    totalFatura: z.number().finite().nullable().optional(),
  })
  .nullable()
  .optional();

const rawPayloadSchema = z.object({
  transactions: z.array(rawRowSchema),
  totals: rawTotalsSchema,
});

/**
 * Printed totals are magnitudes: the statement shows "7.974,83", never a sign.
 * Zero means "nothing charged", which is meaningful, so only null is dropped.
 */
function normalizeTotals(raw: z.infer<typeof rawTotalsSchema>): StatementTotals {
  const mag = (n: number | null | undefined) => (n == null ? null : Math.abs(n));
  return {
    lancamentos: mag(raw?.lancamentos),
    encargos: mag(raw?.encargos),
    totalFatura: mag(raw?.totalFatura),
  };
}

/**
 * Validate and normalize the model's tool output into ExtractedRow[].
 * Pure — no network — so it carries the unit tests.
 *
 * - amount becomes signed: refunds negative, charges positive.
 * - card_last4 trimmed/uppercased, empty → null.
 * - installment pair coerced to both-or-neither; clamps number ≤ total.
 */
export function normalizeExtraction(raw: unknown): ExtractedRow[] {
  return normalizeStatementExtraction(raw).rows;
}

/** As `normalizeExtraction`, but also returns the statement's printed totals. */
export function normalizeStatementExtraction(raw: unknown): {
  rows: ExtractedRow[];
  totals: StatementTotals;
} {
  const { transactions, totals } = rawPayloadSchema.parse(raw);
  const rows = transactions.map((r) => {
    const mag = Math.abs(r.amount);
    const card = (r.cardLast4 ?? '').trim().toUpperCase();

    let inum = r.installmentNumber;
    let itot = r.totalInstallments;
    // Both-or-neither: if one side is missing, drop installment metadata.
    if (inum == null || itot == null || itot < 1 || inum < 1) {
      inum = null;
      itot = null;
    } else if (inum > itot) {
      inum = itot;
    }

    return {
      date: r.date,
      description: r.description.trim(),
      amount: r.isRefund ? -mag : mag,
      cardLast4: card === '' ? null : card,
      installmentNumber: inum,
      totalInstallments: itot,
      isRefund: r.isRefund,
    };
  });
  return { rows, totals: normalizeTotals(totals) };
}

function makeClient(): { client: OpenAI; model: string } {
  // config.ts guarantees the model whenever the key is set; re-checked here so
  // the type narrows.
  if (!config.OPENAI_API_KEY || !config.OPENAI_MODEL) {
    throw new Error('IMPORT_DISABLED');
  }
  const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    // The SDK backs off and retries on 429/5xx and on timeouts. A timed-out
    // extraction re-runs from scratch, so keep the count low: a stuck model
    // should fail in minutes, not after half a dozen full re-reads.
    maxRetries: 2,
    // A 100-line statement is several thousand output tokens (more with a
    // reasoning model); give one read room to finish.
    timeout: 240_000,
    // Unset = api.openai.com. For a gateway use its OpenAI-style base, which
    // includes the version segment (e.g. https://openrouter.ai/api/v1).
    ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
  });
  return { client, model: config.OPENAI_MODEL };
}

/**
 * Wall time of one model call, in seconds with one decimal. The import feels
 * slow and the reason is invisible from outside: a reconcile is 1-3 of these
 * back to back, and the SDK's own 429 backoff (maxRetries above) hides inside
 * a single call. Logging each one is what makes the wait explainable.
 */
const secs = (startedAt: number) => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

async function callRecordTool(
  messages: OpenAI.ChatCompletionMessageParam[],
  label = 'read',
): Promise<{
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall;
  rows: ExtractedRow[];
  totals: StatementTotals;
}> {
  const { client, model } = makeClient();
  const startedAt = Date.now();
  const completion = await client.chat.completions.create({
    model,
    // Counts reasoning tokens too on reasoning models, hence the headroom over
    // the few thousand tokens the JSON itself takes.
    max_completion_tokens: 16_000,
    tools: [RECORD_TOOL],
    tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    messages,
  });
  const choice = completion.choices[0];
  const u = completion.usage;
  console.log(
    `[extract] ${label} took ${secs(startedAt)} — model=${completion.model} ` +
      `in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'} ` +
      `cached=${u?.prompt_tokens_details?.cached_tokens ?? 0} ` +
      `reasoning=${u?.completion_tokens_details?.reasoning_tokens ?? 0} ` +
      `finish=${choice?.finish_reason}`,
  );

  const toolCall = choice?.message.tool_calls?.find(
    (tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall =>
      tc.type === 'function' && tc.function.name === TOOL_NAME,
  );
  if (!toolCall) {
    // Models that ignore a forced tool_choice answer in prose instead; say so
    // rather than failing on a parse error further down.
    throw new Error(
      `Model did not return structured transactions (finish_reason=${choice?.finish_reason})`,
    );
  }
  let args: unknown;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    // finish_reason=length lands here: the JSON was cut off mid-array.
    throw new Error(
      `Model returned malformed tool arguments (finish_reason=${choice.finish_reason})`,
    );
  }
  return { toolCall, ...normalizeStatementExtraction(args) };
}

const sumRows = (rows: ExtractedRow[]) =>
  Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Send the screenshots to the model and return normalized rows.
 * Throws if the import feature is disabled (no API key) or the model declines
 * to call the tool.
 */
export async function extractFaturaFromImages(
  images: FaturaImage[],
  ctx: ExtractContext,
): Promise<ExtractedRow[]> {
  const imageBlocks: OpenAI.ChatCompletionContentPartImage[] = images.map((img) => ({
    type: 'image_url',
    // `high`: statement lines are small text; the low-res pass misreads cents.
    image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'high' },
  }));
  const { rows } = await callRecordTool([
    { role: 'user', content: [...imageBlocks, { type: 'text', text: buildPrompt(ctx) }] },
  ]);
  return rows;
}

function buildPdfPrompt(ctx: ExtractContext): string {
  return [
    'You are reading the TEXT extracted from a Brazilian credit-card statement PDF (fatura fechada, e.g. PicPay/Nubank/Itaú).',
    'Extract EVERY transaction line into the record_transactions tool, plus the totals printed in the statement summary. Rules:',
    '',
    `- The bill covers ${ctx.periodStart} to ${ctx.periodEnd} (today is ${ctx.referenceDate}).`,
    '- Transaction lines look like "24/08 ZP *CPARC11/12 169,70" — date dd/mm, merchant, value in Brazilian format ("1.234,56" → 1234.56).',
    '- Dates are ALWAYS dd/mm, never mm/dd. "07/11" is 7 November — never re-read it as 11 July to make it fit the window.',
    '- Year inference: pick the most recent year that puts the date ON OR BEFORE the closing date ' +
      `${ctx.periodEnd}. Installment purchases (parceladas) keep their ORIGINAL purchase date, which can be many months (or years) before the window — that is expected; do not move them and do not change the day/month to bring them closer.`,
    '- Negative values ("-399,99") are estornos/credits: set isRefund=true and put the positive magnitude in `amount`. Check the minus sign on EVERY line individually — a flipped sign costs twice the value in the reconciliation. Descriptions do not decide this: "CANCELAMENTO", "CREDITO", "Redução" are usually negative, but an ordinary merchant line can be an estorno too, and only the printed sign tells you.',
    '- Installments: a "PARC05/12" fragment (PicPay) or a bare "05/12" at the END of the merchant text (Itaú: "PAYGO*DOCA 66 04/12", "APPLE STORE R6 12/12") means installment 5 of 12 → installmentNumber=5, totalInstallments=12. Keep the merchant text as printed (including the fragment). Lines without such a fragment get null/null.',
    '- Cards: statements group transactions under headers like "Picpay Card final 3021", "KENJI M KINOSHITA … final 3054", or Itaú\'s "Cartão 5300.XXXX.XXXX.3177". Lines under such a header get cardLast4 from it ("3021"). Lines before any card header get null.',
    '',
    'ITAÚ layout specifics (the text is dense and easy to misread):',
    '- Each transaction is followed by a category/city continuation line ("eletronicos SAO PAULO", "restaurante SAO BERNARDO"). It belongs to the transaction above and is NOT a transaction — never record it.',
    '- "Lançamentos internacionais" lines carry TWO amounts. Format:',
    '      10/07 RAILWAYSAN FRANCISCOUSA 27,05',
    '      5,00 USD 5,00',
    '      Dólar de Conversão R$ 5,41',
    '  Record ONLY the R$ value on the dd/mm merchant line (27,05 here). The following lines are the original amount, its currency code and the exchange rate — metadata, never separate transactions and never the amount to use. This holds even when that currency code is BRL: in',
    '      10/07 ANTHROPIC* CLAUDE SUBSA 579,19',
    '      550,00 BRL 107,06',
    '  the amount is 579,19 — NOT 550,00 and NOT 107,06. Getting this wrong understates the bill badly.',
    '- "Repasse de IOF em R$ 24,99" under the international block IS a real charge: record it as a transaction dated ' +
      `${ctx.periodEnd} with description "Repasse de IOF", no installments, no card.`,
    '- "Lançamentos: produtos e serviços" (anuidade, mensalidade, reduções) ARE transactions — record them, with reduções as isRefund=true.',
    '- SKIP the "Compras parceladas - próximas faturas" block entirely: those are FUTURE installments, not charges on this bill. They repeat merchants already listed above with the NEXT installment number (e.g. "PAYGO*DOCA 66 05/12" when the bill charged 04/12) — recording them double-counts the bill.',
    '- SKIP the "Encargos cobrados nesta fatura" breakdown (juros do rotativo, juros de mora, multa por atraso, IOF de financiamento). Report their sum in `totals.encargos` instead.',
    '',
    '- SKIP payment lines: "PAGAMENTO DE FATURA", "PAGAMENTO RECEBIDO", "Pagamento via conta" and similar bill-payment rows.',
    '- SKIP everything else that is not a transaction line: summary boxes (Resumo da fatura, Limites de crédito, pagamento mínimo, CET, simulações), section subtotals ("Lançamentos no cartão", "Total transações inter.", "Total lançamentos inter.", "Lançamentos produtos e serviços", "Total dos lançamentos atuais", "Subtotal dos lançamentos"), addresses, footers and page headers.',
    '- The same PDF page text can interleave two columns; rely on the dd/mm + value pattern to identify real transaction lines.',
    '',
    'TOTALS: copy the printed summary figures into `totals` — `lancamentos` from "Total dos lançamentos atuais" (or "Total dos lançamentos"), `encargos` from "Total de encargos em R$", `totalFatura` from "Total desta fatura". Use null for any the statement does not print. Copy them verbatim; do NOT compute them from the lines you extracted.',
    '',
    'Your transactions, summed with their signs (estornos subtract), must equal the printed `totals.lancamentos` to the centavo. The section subtotals localize any error: the purchases block sums to "Lançamentos no cartão", the international block to "Total lançamentos inter. em R$" (its transactions plus the Repasse de IOF), the services block to "Lançamentos produtos e serviços".',
    '',
    'Call the tool exactly once with all transactions in statement order.',
  ].join('\n');
}

/**
 * How many correction rounds to spend closing the gap between the extracted
 * lines and the statement's own printed total.
 */
const REPAIR_ROUNDS = 2;

/** Agree-to-the-centavo threshold. */
const TOTAL_EPSILON = 0.005;

/**
 * Extract transactions from the raw TEXT of a statement PDF. Text-only — the
 * caller extracts text from the PDF (see routes/faturaImport.ts); sending text
 * instead of the PDF bytes keeps tokens low and works through any gateway.
 */
export async function extractFaturaFromPdfText(
  pdfText: string,
  ctx: ExtractContext,
): Promise<{ rows: ExtractedRow[]; totals: StatementTotals }> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'user',
      content: `${buildPdfPrompt(ctx)}\n\n--- STATEMENT TEXT ---\n${pdfText}`,
    },
  ];

  const startedAt = Date.now();
  console.log(
    `[extract] pdf reconcile start — ${pdfText.length} chars of statement text, ` +
      `window ${ctx.periodStart}..${ctx.periodEnd}`,
  );

  let best = await callRecordTool(messages);

  // Repair loop. Forced tool use gives the model no scratchpad to check its own
  // arithmetic in, so the check happens here: the statement prints its own
  // lançamentos total, and the extracted lines must sum to it. When they don't,
  // hand the model the gap and let it re-read — a missed minus sign or a
  // foreign-currency amount is obvious once you know how much is missing.
  for (let round = 0; round < REPAIR_ROUNDS; round++) {
    const target = best.totals.lancamentos;
    if (target == null) break;
    const gap = Math.round((target - sumRows(best.rows)) * 100) / 100;
    if (Math.abs(gap) < TOTAL_EPSILON) break;

    messages.push(
      { role: 'assistant', content: null, tool_calls: [best.toolCall] },
      {
        role: 'tool',
        tool_call_id: best.toolCall.id,
        content:
          `The transactions you recorded sum to R$ ${brl(sumRows(best.rows))}, but the statement prints ` +
          `R$ ${brl(target)} of lançamentos — a difference of R$ ${brl(gap)}. Something was misread.\n\n` +
          (gap > 0
            ? 'Too little was recorded: a line is missing, an estorno was marked on a line that is actually a charge, or a foreign-currency/exchange-rate figure was used instead of the R$ value on the dd/mm line.\n'
            : 'Too much was recorded: a "Compras parceladas - próximas faturas" line was included, a line was recorded twice, a category/city continuation line was read as a transaction, or a negative line was recorded as positive.\n') +
          '\nRe-read the statement text and call the tool again with the FULL corrected list (all transactions, not just the fix), plus the same totals. ' +
          'Use the section subtotals to find the error: "Lançamentos no cartão", "Total lançamentos inter. em R$", "Lançamentos produtos e serviços". ' +
          'Never invent, drop, or adjust a line just to make the sum agree — correct only what you actually misread, and if you cannot find the error, return the lines as you read them.',
      },
    );

    console.log(
      `[extract] repair round ${round + 1}/${REPAIR_ROUNDS} — rows sum to ` +
        `R$ ${brl(sumRows(best.rows))} vs printed R$ ${brl(target)} (gap R$ ${brl(gap)})`,
    );

    const retry = await callRecordTool(messages, `repair ${round + 1}`);
    const retryGap = Math.abs(target - sumRows(retry.rows));
    // Keep the retry only if it actually got closer — a worse re-read is noise.
    if (retryGap >= Math.abs(gap)) {
      console.log(`[extract] repair ${round + 1} discarded — gap did not improve`);
      break;
    }
    best = retry;
  }

  console.log(
    `[extract] pdf reconcile done in ${secs(startedAt)} — ${best.rows.length} row(s) extracted`,
  );
  return { rows: best.rows, totals: best.totals };
}
