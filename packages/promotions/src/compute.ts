/**
 * Discount computation. Pure integer-cent math; the sole source of the
 * `discount_cents` value that flows into `computeOrderTotals` and onto the
 * order row.
 *
 * Rounding: percent discounts are banker-rounded (round-half-to-even), the
 * same rule @dankdash/pricing uses for taxes. Consistency matters — every
 * cents value in the checkout transaction is produced by the same rounding
 * discipline so the books never disagree by a half cent.
 *
 * Clamping order for a percent code: round first, then apply
 * `maxDiscountCents`, then clamp to the subtotal. A discount can never exceed
 * the subtotal (pricing rejects `discount > subtotal`), and it is applied off
 * the post-tax total, so taxes are still computed and remitted on the full
 * pre-discount price — the promo's funder absorbs the discount, not the state.
 */
import { Decimal } from 'decimal.js';
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN } from './constants.js';
import type { PromoDefinition } from './types.js';

function requireNonNegativeInt(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `promotions: ${label} must be a non-negative integer (got ${String(value)})`,
    );
  }
}

function bankerRoundToInt(d: Decimal): number {
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

/**
 * Compute the discount, in integer cents, that `promo` yields against a cart
 * with the given subtotal and delivery fee. Never negative, never greater
 * than `subtotalCents`. Does not consult eligibility (window, caps, min
 * subtotal) — call `evaluatePromo` for the gated result.
 */
export function computeDiscountCents(
  promo: PromoDefinition,
  subtotalCents: number,
  deliveryFeeCents: number,
): number {
  requireNonNegativeInt(subtotalCents, 'subtotalCents');
  requireNonNegativeInt(deliveryFeeCents, 'deliveryFeeCents');

  let raw: number;
  switch (promo.type) {
    case 'percent': {
      if (
        !Number.isInteger(promo.value) ||
        promo.value < PROMO_PERCENT_MIN ||
        promo.value > PROMO_PERCENT_MAX
      ) {
        throw new RangeError(
          `promotions: percent promo value must be an integer in [${String(PROMO_PERCENT_MIN)}, ${String(
            PROMO_PERCENT_MAX,
          )}] (got ${String(promo.value)})`,
        );
      }
      const pct = bankerRoundToInt(new Decimal(subtotalCents).times(promo.value).dividedBy(100));
      raw = promo.maxDiscountCents === null ? pct : Math.min(pct, promo.maxDiscountCents);
      break;
    }
    case 'fixed_amount': {
      requireNonNegativeInt(promo.value, 'fixed_amount value');
      raw = promo.value;
      break;
    }
    case 'free_delivery': {
      raw = deliveryFeeCents;
      break;
    }
  }

  // A discount can never exceed what is owed on the goods.
  return Math.min(raw, subtotalCents);
}
