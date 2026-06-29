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

// The tool the model is forced to call. Amounts come back as a POSITIVE
// magnitude plus an `isRefund` flag; normalizeExtraction applies the sign.
const RECORD_TOOL: Anthropic.Tool = {
  name: 'record_transactions',
  description:
    'Record every purchase/charge line read from the credit-card fatura screenshots.',
  input_schema: {
    type: 'object',
    properties: {
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

const rawPayloadSchema = z.object({ transactions: z.array(rawRowSchema) });

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

/**
 * Send the screenshots to Claude and return normalized rows.
 * Throws if the import feature is disabled (no API key) or the model declines
 * to call the tool.
 */
export async function extractFaturaFromImages(
  images: FaturaImage[],
  ctx: ExtractContext,
): Promise<ExtractedRow[]> {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('IMPORT_DISABLED');
  }
  const client = new Anthropic({
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

  const imageBlocks: Anthropic.ImageBlockParam[] = images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.mediaType as Anthropic.Base64ImageSource['media_type'],
      data: img.data,
    },
  }));

  const message = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 8000,
    tools: [RECORD_TOOL],
    tool_choice: { type: 'tool', name: 'record_transactions' },
    messages: [
      {
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: buildPrompt(ctx) }],
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    throw new Error('Model did not return structured transactions');
  }
  return normalizeExtraction(toolUse.input);
}
