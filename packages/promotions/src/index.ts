/**
 * @dankdash/promotions public surface.
 *
 * Consumed by:
 *   - apps/api cart service (live discount preview on apply/remove + reads)
 *   - apps/api checkout service (authoritative re-evaluation inside the order
 *     transaction; the computed discount is snapshotted onto the order and a
 *     `promo_redemptions` row is written in the same tx)
 *   - apps/api settlement path (reads `fundedBy` off the order to route the
 *     discount cost to the platform or the dispensary leg of the ledger)
 *   - the iOS client mirror (offline preview)
 */
export {
  PROMO_CODE_MAX_LENGTH,
  PROMO_CODE_MIN_LENGTH,
  PROMO_PERCENT_MAX,
  PROMO_PERCENT_MIN,
  normalizePromoCode,
} from './constants.js';
export { computeDiscountCents } from './compute.js';
export { evaluatePromo } from './evaluate.js';
export type {
  PromoDefinition,
  PromoEvaluation,
  PromoEvaluationContext,
  PromoRejectionReason,
  PromoScope,
  PromoType,
} from './types.js';
