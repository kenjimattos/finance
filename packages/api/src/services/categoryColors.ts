/**
 * Auto-assigned palette for user categories.
 *
 * The user doesn't pick colors when creating a category — we hand them one
 * from this curated list. Chosen to work on the light, warm-paper background
 * we use in the frontend: muted but distinct, no neon except a single accent.
 *
 * When a new category is created, we pick the next color that's currently
 * least used by existing categories, falling back to modulo if all are used.
 */

export const CATEGORY_PALETTE: string[] = [
  '#C2410C', // burnt orange
  '#4D7C0F', // olive
  '#0F766E', // teal
  '#7C3AED', // violet
  '#B45309', // amber
  '#BE123C', // crimson
  '#1D4ED8', // indigo
  '#047857', // emerald
  '#A16207', // mustard
  '#9333EA', // purple
  '#065F46', // forest
  '#9F1239', // rose
];

export function pickNextColor(existingColors: string[]): string {
  const usage = new Map<string, number>();
  for (const color of CATEGORY_PALETTE) usage.set(color, 0);
  for (const used of existingColors) {
    if (usage.has(used)) usage.set(used, usage.get(used)! + 1);
  }
  let best = CATEGORY_PALETTE[0];
  let bestCount = Infinity;
  for (const color of CATEGORY_PALETTE) {
    const count = usage.get(color)!;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}
