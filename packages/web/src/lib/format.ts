/**
 * pt-BR formatters. Kept in one place so number/date rendering is consistent
 * across every component.
 */

const CURRENCY = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const CURRENCY_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});

const DATE_SHORT = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
});

const DATE_LONG = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'long',
});

const MONTH_YEAR = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
});

export function formatBRL(value: number): string {
  return CURRENCY.format(value);
}

export function formatBRLCompact(value: number): string {
  return CURRENCY_COMPACT.format(value);
}

export function formatDateShort(iso: string): string {
  return DATE_SHORT.format(parseYmd(iso)).replace('.', '').replace(/ de /g, ' ');
}

export function formatDateLong(iso: string): string {
  return DATE_LONG.format(parseYmd(iso));
}

/** "março 2026" — month + year, no day. */
export function formatMonthYear(iso: string): string {
  return MONTH_YEAR.format(parseYmd(iso)).replace(/ de /g, ' ');
}

function parseYmd(iso: string): Date {
  // iso is expected to be yyyy-mm-dd. Build a local Date at midnight
  // (no UTC conversion) so "08 abr" doesn't shift to "07 abr".
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Format a card_last4 value for display.
 * Numeric (4 digits) → "····1234"
 * Non-numeric (e.g. "DIGITAL-PICPAY") → title-cased with hyphens as spaces
 */
export function formatCardLabel(cardLast4: string): string {
  if (/^\d{4}$/.test(cardLast4)) return `····${cardLast4}`;
  // Title-case: "DIGITAL-PICPAY" → "Digital Picpay"
  return cardLast4
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Sign-aware delta formatting. Positive = more expensive than last period
 * (shown with an up triangle), negative = cheaper (down triangle).
 * Never uses red/green because the same number can be good or bad
 * depending on the user's framing.
 */
export function formatDelta(value: number): { symbol: string; text: string } {
  const abs = Math.abs(value);
  if (abs < 0.01) return { symbol: '—', text: 'sem variação' };
  return {
    symbol: value > 0 ? '▲' : '▼',
    text: formatBRL(abs),
  };
}
