/**
 * Merchant slug extraction — the heart of the learning loop.
 *
 * When the user categorizes a transaction, we derive a stable "merchant slug"
 * from its description. Later transactions whose description produces the
 * same slug get auto-categorized.
 *
 * Descriptions from Brazilian issuers are messy, e.g.:
 *   "IFOOD *RESTAURANTE XYZ"
 *   "UBER   *TRIP BR"
 *   "PAG*UBER"
 *   "AMAZON.COM.BR"
 *   "MERCADO LIVRE*ML"
 *   "EC *NETFLIX.COM"
 *
 * Heuristic:
 *  1. Uppercase, trim, collapse whitespace.
 *  2. Strip common processor prefixes ("PAG*", "EC *", "DL*", "MP*", "PP*").
 *  3. Take the portion before the first "*" or " - " — that's usually the merchant.
 *  4. Drop trailing country/location tokens ("BR", "SAO PAULO BR", etc.).
 *  5. Strip non-alphanumerics except spaces, collapse spaces again.
 *  6. Take the first 1–3 tokens as the slug (rarely more — longer descriptions
 *     usually have store-specific noise after).
 *
 * The slug balances precision and recall: "UBER *EATS" and "UBER *TRIP" produce
 * different slugs ("UBER EATS", "UBER TRIP") so they can map to different
 * categories, but "IFOOD *RESTAURANTE A" and "IFOOD *RESTAURANTE B" still
 * collapse to the same slug ("IFOOD RESTAURANTE") because the differing part
 * is short noise. The user still has manual override for edge cases.
 */

const PROCESSOR_PREFIXES = /^(PAG|EC|DL|MP|PP|PAGSEGURO|PAGS|PAGSEG|STN|STONE)\s*\*\s*/i;
const TRAILING_LOCATION =
  /\s+(BR|BRA|BRASIL|SAO PAULO|RIO DE JANEIRO|BELO HORIZONTE|SP|RJ|MG|PR|SC|RS|BA|CE|PE|DF)$/i;

export function extractMerchantSlug(description: string | null | undefined): string | null {
  if (!description) return null;

  let s = description.toUpperCase().trim().replace(/\s+/g, ' ');
  if (!s) return null;

  // Strip processor prefixes like "PAG*", "EC *", "DL*"
  s = s.replace(PROCESSOR_PREFIXES, '');

  // Cut at " - " (dash separator) if present
  const dashIdx = s.indexOf(' - ');
  if (dashIdx > 0) s = s.slice(0, dashIdx).trim();

  // Handle star separator: take the part before `*` as the merchant base,
  // then preserve the first token after `*` if it's a meaningful qualifier
  // (>= 3 alphabetic chars). This splits "UBER *EATS" → "UBER EATS" and
  // "UBER *TRIP" → "UBER TRIP", while still collapsing "IFOOD *A" → "IFOOD"
  // and "MERCADO LIVRE*ML" → "MERCADO LIVRE".
  const starIdx = s.indexOf('*');
  if (starIdx > 0) {
    const before = s.slice(0, starIdx).trim();
    const afterToken = s.slice(starIdx + 1).trim().split(/\s+/)[0] ?? '';
    s = (afterToken.length >= 3 && /^[A-Z]+$/.test(afterToken))
      ? `${before} ${afterToken}`
      : before;
  }

  // Strip trailing location tokens
  s = s.replace(TRAILING_LOCATION, '').trim();

  // Keep only alphanumerics, dots and spaces; collapse spaces
  s = s.replace(/[^A-Z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s) return null;

  // Take first 3 tokens max — keeps the slug stable across noisy variants
  const tokens = s.split(' ').filter(Boolean).slice(0, 3);
  const slug = tokens.join(' ');

  // Reject slugs that are just noise (pure numbers, too short)
  if (slug.length < 2) return null;
  if (/^[0-9.]+$/.test(slug)) return null;

  return slug;
}

/**
 * Legacy slug extraction — preserves the pre-v2 behavior where everything
 * after `*` is discarded. Used only in applyLearnedRules as a fallback so
 * existing rules (keyed on old slugs) keep matching until new rules with
 * the improved slugs are naturally created through user categorizations.
 *
 * @deprecated Will be removed once existing rules have aged out.
 */
export function extractLegacySlug(description: string | null | undefined): string | null {
  if (!description) return null;

  let s = description.toUpperCase().trim().replace(/\s+/g, ' ');
  if (!s) return null;

  s = s.replace(PROCESSOR_PREFIXES, '');

  // Old behavior: discard everything after first `*` or ` - `
  const starIdx = s.indexOf('*');
  const dashIdx = s.indexOf(' - ');
  const cutPoints = [starIdx, dashIdx].filter((i) => i > 0);
  if (cutPoints.length > 0) {
    s = s.slice(0, Math.min(...cutPoints)).trim();
  }

  s = s.replace(TRAILING_LOCATION, '').trim();
  s = s.replace(/[^A-Z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();

  if (!s) return null;

  const tokens = s.split(' ').filter(Boolean).slice(0, 3);
  const slug = tokens.join(' ');

  if (slug.length < 2) return null;
  if (/^[0-9.]+$/.test(slug)) return null;

  return slug;
}
