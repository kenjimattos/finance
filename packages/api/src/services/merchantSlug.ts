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
 * The slug is intentionally fuzzy: "IFOOD RESTAURANTE A" and "IFOOD RESTAURANTE B"
 * should both collapse to "IFOOD". This trades precision for recall, which is
 * what we want — the user still has the manual override for edge cases, and
 * a 95%-accurate auto-categorizer beats a 100% manual one for daily use.
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

  // Take the chunk before the first "*" or " - " — that's usually the merchant name
  const starIdx = s.indexOf('*');
  const dashIdx = s.indexOf(' - ');
  const cutPoints = [starIdx, dashIdx].filter((i) => i > 0);
  if (cutPoints.length > 0) {
    s = s.slice(0, Math.min(...cutPoints)).trim();
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
