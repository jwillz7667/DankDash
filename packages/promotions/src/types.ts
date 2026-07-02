/**
 * Promotion domain types. Every monetary value is an integer cent count —
 * floats are forbidden here for the same reason they are in @dankdash/pricing:
 * the discount this package computes is fed straight into `computeOrderTotals`
 * and persisted on `orders.discount_cents`, where a half-cent error would
 * break the `orders_total_matches` CHECK constraint at checkout.
 */

/**
 * Discount mechanics.
 *   - `percent`        — `value` is a whole-number percent (1..100) taken off
 *                        the cart subtotal, banker-rounded to whole cents and
 *                        then clamped by `maxDiscountCents` when set.
 *   - `fixed_amount`   — `value` is a flat discount in integer cents, clamped
 *                        to the subtotal (a promo can never exceed what is
 *                        owed).
 *   - `free_delivery`  — waives the delivery fee. `value` is unused (0). The
 *                        discount equals the delivery fee, clamped to the
 *                        subtotal. Delivery fees are structurally 0 in the
 *                        current build, so this yields 0 until they land.
 */
export type PromoType = 'percent' | 'fixed_amount' | 'free_delivery';

/**
 * Who funds the discount. This is the single fact the settlement ledger
 * needs to route the promo cost to the right party:
 *   - `platform`   — the platform eats it: the dispensary is paid as though
 *                    no discount existed and the platform's revenue leg
 *                    absorbs the cost (and may go negative).
 *   - `dispensary` — the dispensary eats it: its payout leg is reduced by the
 *                    discount; the platform still collects its full fee.
 * A promo's scope IS its funding source — a platform-scoped code is
 * platform-funded, a dispensary-scoped code is dispensary-funded.
 */
export type PromoScope = 'platform' | 'dispensary';

/**
 * The subset of a `promo_codes` row the pure evaluator needs. The repository
 * maps its persisted row onto this shape; iOS mirrors it for preview.
 */
export interface PromoDefinition {
  readonly id: string;
  readonly code: string;
  readonly type: PromoType;
  /** Percent (1..100) for `percent`; integer cents (>0) for `fixed_amount`; 0 for `free_delivery`. */
  readonly value: number;
  readonly scope: PromoScope;
  /** Non-null exactly when `scope === 'dispensary'`. */
  readonly dispensaryId: string | null;
  readonly minSubtotalCents: number;
  /** Upper bound on the computed discount (percent codes). `null` = uncapped. */
  readonly maxDiscountCents: number | null;
  readonly startsAt: Date;
  /** `null` = no end date. */
  readonly endsAt: Date | null;
  /** Global redemption cap across all users. `null` = unlimited. */
  readonly maxRedemptions: number | null;
  /** Per-user redemption cap. Always >= 1. */
  readonly maxRedemptionsPerUser: number;
  readonly active: boolean;
}

/**
 * The cart-side context a promo is evaluated against. `globalRedemptionCount`
 * and `userRedemptionCount` are supplied by the caller (counted from
 * `promo_redemptions`) so this package stays pure — it never touches the DB.
 */
export interface PromoEvaluationContext {
  readonly subtotalCents: number;
  /** Delivery fee at evaluation time; drives `free_delivery`. 0 in the current build. */
  readonly deliveryFeeCents: number;
  readonly cartDispensaryId: string;
  readonly now: Date;
  /** Count of existing redemptions of this promo across all users. */
  readonly globalRedemptionCount: number;
  /** Count of existing redemptions of this promo by the current user. */
  readonly userRedemptionCount: number;
}

/**
 * Machine-readable rejection reason. Maps 1:1 to the API's `PromoError` codes
 * (the `PROMO_` prefix is added at the boundary). `not_found` is deliberately
 * NOT here — a missing code is an API-layer concern (the repository lookup
 * returned nothing), not a property of an existing promo.
 */
export type PromoRejectionReason =
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'wrong_dispensary'
  | 'min_subtotal'
  | 'exhausted'
  | 'already_used';

export type PromoEvaluation =
  | {
      readonly ok: true;
      readonly promoId: string;
      readonly discountCents: number;
      readonly fundedBy: PromoScope;
    }
  | {
      readonly ok: false;
      readonly reason: PromoRejectionReason;
    };
