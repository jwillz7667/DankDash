/**
 * Minnesota cannabis statutory constants.
 *
 * Single source of truth for the numeric limits enforced by the compliance
 * engine. Every value carries a citation to the originating section of
 * Minn. Stat. § 342 (the Cannabis Management Act).
 *
 * Do not duplicate these values anywhere else in the codebase. The iOS
 * consumer renders the same caps for UX preview ("you can still add 12g of
 * flower") — it must import them from the @dankdash/compliance public
 * surface, never inline them. The server is the authority; the client is
 * a preview.
 *
 * Mutating any value here requires:
 *   1. A bump of COMPLIANCE_EVALUATION_VERSION below, AND
 *   2. A re-evaluation pass over every active cart, AND
 *   3. A migration note recording the statute change that motivated it.
 *
 * Test fixtures must not relax these; write fixtures that pass legitimately
 * or test the failure path explicitly.
 */
import { Decimal } from 'decimal.js';

/**
 * Per-transaction adult-use caps — Minn. Stat. § 342.27, subd. (c)(1)–(3).
 *
 * Interpreted as the total of all items in a single cart, summed by product
 * category. Category aggregation (e.g. vape carts count toward concentrate)
 * is defined in `cart-math.ts`.
 *
 * Stored as Decimal so equality at the boundary is exact. The JS float
 * literal `56.7` is actually `56.69999999999999573674...`, which would
 * silently reject carts that hit the cap to three decimal places.
 *
 *   - flowerGramsMax: 2 oz, per MN OCM enforcement-rounding guidance
 *     (exact 2 × 28.3495231g = 56.6990462g, statute rounds to 56.7g).
 *   - concentrateGramsMax: 8 g across concentrate and vape categories.
 *   - edibleThcMgMax: 800 mg total THC across edibles, beverages, tinctures.
 */
export const MN_PER_TRANSACTION_LIMITS = {
  flowerGramsMax: new Decimal('56.7'),
  concentrateGramsMax: new Decimal('8'),
  edibleThcMgMax: new Decimal('800'),
} as const;

/**
 * Sale-time window — Minn. Stat. § 342.27, subd. (d). Sales are prohibited
 * between 2:00 AM and 8:00 AM local time. The window is a state cap;
 * dispensaries may narrow it (e.g. open 10–22) but never widen it.
 *
 * Modelled as a half-open interval [earliestOpen, latestClose). A sale at
 * exactly 2:00 AM is prohibited; a sale at exactly 8:00 AM is permitted.
 *
 * latestClose.hour is 26 rather than 2 so the close moment lives on the
 * same calendar day as `now` and the comparison reduces to a single
 * monotone interval check. Consumers translate to clock time via
 * `hour % 24` plus a conditional `+1 day` when setting on a luxon
 * DateTime — see rules/check-hours.ts.
 */
export const MN_SALES_HOURS = {
  earliestOpen: { hour: 8, minute: 0 },
  latestClose: { hour: 26, minute: 0 },
} as const;

/**
 * Cannabis-beverage product gates — Minn. Stat. § 342.27, subd. (e).
 *
 * These are admission gates on the product itself (catalog) AND a runtime
 * check at evaluation time (rules/check-product-provenance.ts). Beverages
 * additionally count toward the edible-THC per-transaction limit above.
 */
export const MN_BEVERAGE_LIMITS = {
  thcMgPerServingMax: new Decimal('10'),
  servingsPerContainerMax: 2,
} as const;

/**
 * Minimum age for adult-use purchase — Minn. Stat. § 342.46. A consumer
 * with `dateOfBirth` exactly 21 years prior to `now` passes; one second
 * younger fails.
 */
export const MN_MINIMUM_AGE_YEARS = 21;

/**
 * Default dispensary timezone. Minnesota observes Central time year-round
 * and `America/Chicago` is the IANA zone that handles its DST transitions
 * correctly. Hard-coded as the default because every licensed dispensary
 * in the state shares this zone; the `EvaluationContext.dispensary.timezone`
 * field still carries the per-dispensary zone so tribal jurisdictions on
 * non-Central zones do not require a constants change.
 */
export const MN_DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Stamped onto every ComplianceEvaluation snapshot (and persisted on
 * `orders.compliance_check_payload`) so a future auditor can replay the
 * evaluation against the rules in force at the time. Bump whenever rule
 * code or any constant in this file changes.
 *
 * Format: `YYYY-MM-DD.N` where N is the nth change on that day.
 */
export const COMPLIANCE_EVALUATION_VERSION = '2026-05-18.1';
