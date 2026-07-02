/**
 * Promo-code shape constants. These bound what a promo code string may look
 * like and are enforced identically at the API boundary (the create DTO) and
 * here (via `normalizePromoCode`), so a code that round-trips through the
 * portal always matches the `citext` unique index the same way.
 */

/** Inclusive minimum promo-code length. */
export const PROMO_CODE_MIN_LENGTH = 3;

/** Inclusive maximum promo-code length. */
export const PROMO_CODE_MAX_LENGTH = 40;

/** Whole-percent bounds for a `percent` promo's `value`. */
export const PROMO_PERCENT_MIN = 1;
export const PROMO_PERCENT_MAX = 100;

/**
 * Canonicalize a user-entered code: trim surrounding whitespace and uppercase.
 * The DB column is `citext` (case-insensitive) so this is belt-and-suspenders
 * for display consistency and for building the lookup key — `save10` and
 * `SAVE10` resolve to the same promo.
 */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}
