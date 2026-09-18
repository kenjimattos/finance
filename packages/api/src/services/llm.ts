/**
 * The OpenAI-compatible client shared by the LLM features: fatura screenshot
 * import (services/extractFatura.ts) and PDF reconciliation
 * (services/reconcileFatura.ts).
 *
 * Works against OpenAI directly or any compatible gateway (OpenRouter) via
 * OPENAI_BASE_URL. Each feature picks its own model, because they ask very
 * different things of it: transcribing screenshots is light work, while
 * reconciling a whole statement against the app is judgment-heavy.
 */
import OpenAI from 'openai';
import { config } from '../config.js';

export type LlmFeature = 'import' | 'reconcile';

export function isLlmEnabled(): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

function modelFor(feature: LlmFeature): string | undefined {
  return feature === 'reconcile'
    ? (config.OPENAI_RECONCILE_MODEL ?? config.OPENAI_MODEL)
    : config.OPENAI_MODEL;
}

/**
 * Throws `IMPORT_DISABLED` when no key is configured; routes turn that into a
 * 503. config.ts guarantees a model whenever the key is set — re-checked here
 * so the type narrows.
 */
export function makeClient(
  feature: LlmFeature,
  opts: { timeoutMs: number; maxRetries: number },
): { client: OpenAI; model: string } {
  const model = modelFor(feature);
  if (!config.OPENAI_API_KEY || !model) {
    throw new Error('IMPORT_DISABLED');
  }
  const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    // The SDK retries on 429/5xx and on timeouts. A retry re-runs the whole
    // read, so callers keep the count low.
    maxRetries: opts.maxRetries,
    timeout: opts.timeoutMs,
    // Unset = api.openai.com. A gateway's OpenAI-style base includes the
    // version segment (e.g. https://openrouter.ai/api/v1).
    ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
  });
  return { client, model };
}

/** Wall time since `startedAt`, in seconds with one decimal, for [llm] logs. */
export const secs = (startedAt: number) => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
