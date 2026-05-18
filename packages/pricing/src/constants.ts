/**
 * Minnesota tax rates for cannabis retail.
 *
 * Sources:
 *   - Cannabis gross-receipts tax: Minn. Stat. § 295.81, subd. 2 — 10%
 *     of gross receipts from retail sales of cannabis flower, cannabis
 *     products, lower-potency hemp edibles, and hemp-derived consumer
 *     products. Imposed on the seller; passed to the customer at the
 *     register per industry practice.
 *   - State sales tax: Minn. Stat. § 297A.62 — 6.875% general rate.
 *
 * Rates are checked in as decimal strings so `decimal.js` consumes them
 * losslessly. `Number('0.06875')` is exactly representable, but other
 * future rates (e.g. a 0.001 surcharge) may not be — keeping the strings
 * future-proofs the arithmetic.
 *
 * Local sales tax (e.g. Minneapolis adds 0.5%, Hennepin County adds
 * 0.15%) is configured per-dispensary on its municipality record and
 * passed in as `localSalesTaxRate` on `PricingOptions`. The locals are
 * NOT centralized here because the rate set changes annually and is the
 * dispensary admin's responsibility to keep current.
 *
 * Per CLAUDE.md non-negotiables: these constants MUST NOT be redefined
 * anywhere else and MUST NOT be mutated for tests. Tests that need to
 * exercise different rates pass `localSalesTaxRate` explicitly.
 */
import type { ProductType } from '@dankdash/compliance';

/** Minn. Stat. § 295.81 — 10% cannabis gross-receipts tax. */
export const CANNABIS_TAX_RATE = '0.10';

/** Minn. Stat. § 297A.62 — 6.875% state sales tax. */
export const STATE_SALES_TAX_RATE = '0.06875';

/**
 * Platform take-rate on the cannabis subtotal (15%). Applied at settlement
 * to split funds between the dispensary and the platform. Not a tax — this
 * is the marketplace commission per the dispensary partner agreement.
 *
 * Per-dispensary overrides are out of scope for Phase 6 — every dispensary
 * pays the same rate until the contracts surface lands. When that happens,
 * move this to a `dispensaries.platform_fee_rate` column with this value
 * as the default.
 *
 * Stored as a decimal string so `decimal.js` consumes it losslessly and
 * banker-rounds the cents value the same way taxes are computed.
 */
export const PLATFORM_FEE_RATE = '0.15';

/**
 * Product types subject to the cannabis gross-receipts tax. Per § 295.81
 * subd. 1(g), "cannabis product" is defined broadly to include cannabis
 * flower, ingestibles, concentrates, topicals, and immature plants /
 * seeds when sold by a licensed retailer.
 *
 * Only the `accessory` type is exempt — papers, pipes, grinders, and
 * other non-cannabis merchandise. Those are still subject to state +
 * local sales tax, just not the 10% excise.
 */
const CANNABIS_TAXABLE: ReadonlySet<ProductType> = new Set<ProductType>([
  'flower',
  'preroll',
  'infused_preroll',
  'vape',
  'concentrate',
  'edible',
  'beverage',
  'tincture',
  'topical',
  'seed',
  'clone',
]);

export function isCannabisTaxable(productType: ProductType): boolean {
  return CANNABIS_TAXABLE.has(productType);
}
