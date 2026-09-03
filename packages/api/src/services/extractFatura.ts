/**
 * Extract credit-card transactions from fatura screenshots using Claude vision.
 *
 * Pluggy does not expose open-bill transactions, and even closed bills can miss
 * rows. This service lets the user photograph the issuer's app statement; Claude
 * reads each line and returns structured transactions, which the import route
 * then inserts as `source='manual'`.
 *
 * The model call is isolated behind `extractFaturaFromImages`. The parsing and
 * sign/installment normalization live in the pure `normalizeExtraction`, which
 * is unit-tested without any network.
 */
import Anthropic from '@anthropic-ai/sdk';
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
  return Boolean(config.ANTHROPIC_API_KEY);
}

/**
 * Normalize a configured base URL for the Anthropic SDK.
 *
 * The SDK appends `/v1/messages` to baseURL itself. Gateways like OpenRouter
 * document their base as `https://openrouter.ai/api/v1` (OpenAI convention), so
 * a naive copy yields `…/api/v1/v1/messages` → 404. Strip a trailing `/v1` (and
 * any trailing slash) so both `…/api` and `…/api/v1` work.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
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

// The tool the model is forced to call. Amounts come back as a POSITIVE
// magnitude plus an `isRefund` flag; normalizeExtraction applies the sign.
const RECORD_TOOL: Anthropic.Tool = {
  name: 'record_transactions',
  description:
    'Record every purchase/charge line read from the credit-card fatura, plus the totals printed in its summary box.',
  input_schema: {
    type: 'object',
    properties: {
      totals: {
        type: 'object',
        description:
          'Totals copied verbatim from the statement summary. Only for PDFs that print them; omit or null each field otherwise.',
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
    required: ['transactions'],
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

function makeClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('IMPORT_DISABLED');
  }
  return new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    // Free gateway tiers (e.g. OpenRouter's :free models) 429 under load. The
    // SDK backs off and retries on 429/5xx; bump the count so transient upstream
    // rate-limits usually clear within one import attempt.
    maxRetries: 5,
    timeout: 120_000,
    ...(config.ANTHROPIC_BASE_URL
      ? { baseURL: normalizeBaseUrl(config.ANTHROPIC_BASE_URL) }
      : {}),
  });
}

/**
 * Wall time of one model call, in seconds with one decimal. The import feels
 * slow and the reason is invisible from outside: a reconcile is 1-3 of these
 * back to back, and the SDK's own 429 backoff (maxRetries above) hides inside
 * a single call. Logging each one is what makes the wait explainable.
 */
const secs = (startedAt: number) => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

async function callRecordTool(
  messages: Anthropic.MessageParam[],
  label = 'read',
): Promise<{
  toolUse: Anthropic.ToolUseBlock;
  rows: ExtractedRow[];
  totals: StatementTotals;
}> {
  const client = makeClient();
  const startedAt = Date.now();
  const message = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 8000,
    tools: [RECORD_TOOL],
    tool_choice: { type: 'tool', name: 'record_transactions' },
    messages,
  });
  const u = message.usage;
  console.log(
    `[extract] ${label} took ${secs(startedAt)} — model=${config.ANTHROPIC_MODEL} ` +
      `in=${u.input_tokens} out=${u.output_tokens} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
      `stop=${message.stop_reason}`,
  );

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    throw new Error('Model did not return structured transactions');
  }
  return { toolUse, ...normalizeStatementExtraction(toolUse.input) };
}

const sumRows = (rows: ExtractedRow[]) =>
  Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Send the screenshots to Claude and return normalized rows.
 * Throws if the import feature is disabled (no API key) or the model declines
 * to call the tool.
 */
export async function extractFaturaFromImages(
  images: FaturaImage[],
  ctx: ExtractContext,
): Promise<ExtractedRow[]> {
  const imageBlocks: Anthropic.ImageBlockParam[] = images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.mediaType as Anthropic.Base64ImageSource['media_type'],
      data: img.data,
    },
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
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `${buildPdfPrompt(ctx)}\n\n--- STATEMENT TEXT ---\n${pdfText}` }],
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
      { role: 'assistant', content: [best.toolUse] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: best.toolUse.id,
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
        ],
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
