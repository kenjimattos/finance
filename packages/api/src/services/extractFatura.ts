/**
 * Extract credit-card transactions from fatura screenshots, using an
 * OpenAI-compatible vision model.
 *
 * Pluggy does not expose open-bill transactions, and even closed bills can miss
 * rows. This service lets the user photograph the issuer's app statement; the
 * model reads each line and returns structured transactions, which the import
 * route then inserts as `source='manual'`.
 *
 * The client speaks the OpenAI Chat Completions format, so it works against
 * OpenAI directly or any compatible gateway (OpenRouter) via OPENAI_BASE_URL.
 *
 * The model call is isolated behind `extractFaturaFromImages`. The parsing and sign/installment normalization
 * live in the pure `normalizeExtraction`, which is unit-tested without any
 * network.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { makeClient, secs } from './llm.js';

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

export { isLlmEnabled as isImportEnabled } from './llm.js';

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
      'Record every purchase/charge line read from the credit-card fatura.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
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
      required: ['transactions'],
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

const rawPayloadSchema = z.object({
  transactions: z.array(rawRowSchema),
});

/**
 * Validate and normalize the model's tool output into ExtractedRow[].
 * Pure — no network — so it carries the unit tests.
 *
 * - amount becomes signed: refunds negative, charges positive.
 * - card_last4 trimmed/uppercased, empty → null.
 * - installment pair coerced to both-or-neither; clamps number ≤ total.
 */
export function normalizeExtraction(raw: unknown): ExtractedRow[] {
  const { transactions } = rawPayloadSchema.parse(raw);
  return transactions.map((r) => {
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
}

async function callRecordTool(messages: OpenAI.ChatCompletionMessageParam[]): Promise<ExtractedRow[]> {
  // A 100-line statement is several thousand output tokens (more with a
  // reasoning model); give one read room to finish, and fail rather than
  // re-run a stuck read many times.
  const { client, model } = makeClient('import', { timeoutMs: 240_000, maxRetries: 2 });
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
    `[extract] read took ${secs(startedAt)} — model=${completion.model} ` +
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
  return normalizeExtraction(args);
}

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
  return callRecordTool([
    { role: 'user', content: [...imageBlocks, { type: 'text', text: buildPrompt(ctx) }] },
  ]);
}
