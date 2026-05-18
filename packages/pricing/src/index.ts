/**
 * @dankdash/pricing public surface.
 *
 * Consumed by:
 *   - apps/api cart service (preview pricing on cart reads)
 *   - apps/api checkout service (authoritative pricing inside the txn
 *     that snapshots the order; the CHECK constraint on `orders` will
 *     reject any drift between this output and what's persisted)
 *   - the iOS client mirror (via @dankdash/types-generated)
 *
 * Additions here are a workspace-wide contract change. Bump the package
 * version and re-test the checkout integration suite before landing.
 */
export {
  CANNABIS_TAX_RATE,
  PLATFORM_FEE_RATE,
  STATE_SALES_TAX_RATE,
  isCannabisTaxable,
} from './constants.js';
export { computeOrderTotals, computePlatformFeeCents } from './totals.js';
export type {
  OrderPricingTotals,
  PricingLine,
  PricingLineResult,
  PricingOptions,
  PricingResult,
} from './types.js';
