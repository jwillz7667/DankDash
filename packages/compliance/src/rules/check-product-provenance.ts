/**
 * Product-provenance rule.
 *
 * Today this rule enforces the cannabis-beverage product gates from
 * Minn. Stat. § 342.27, subd. (e):
 *
 *   - ≤ 10 mg THC per serving
 *   - ≤ 2 servings per container
 *
 * Beverages that arrive without `thcMgPerServing` or `servingCount`
 * populated are data-integrity failures and fail closed — a beverage
 * line that cannot be checked must not be sold. The catalog admission
 * gate (PHASE 4) is the primary defence; this runtime check is the
 * server-side safety net in case bad data sneaks past it.
 *
 * The rule iterates all cart lines (rather than returning on first
 * failure) so `details.violations` reports every offending line. The
 * iOS client uses the `lineId` to highlight bad rows in place.
 *
 * Non-beverage product types are skipped silently; future provenance
 * checks (e.g. lab COA freshness, Metrc package validity) live in this
 * rule and will follow the same per-line violations shape.
 */
import { MN_BEVERAGE_LIMITS } from '../constants.js';
import type { EvaluationContext, RuleResult } from '../types.js';

type Violation =
  | { readonly lineId: string; readonly reason: 'beverage_thc_per_serving_missing' }
  | {
      readonly lineId: string;
      readonly reason: 'beverage_potency_exceeds_cap';
      readonly value: number;
      readonly cap: number;
    }
  | { readonly lineId: string; readonly reason: 'beverage_serving_count_missing' }
  | {
      readonly lineId: string;
      readonly reason: 'beverage_servings_exceeds_cap';
      readonly value: number;
      readonly cap: number;
    };

export function checkProductProvenance(ctx: EvaluationContext): RuleResult {
  const violations: Violation[] = [];

  for (const line of ctx.cart) {
    if (line.productType !== 'beverage') continue;

    if (line.thcMgPerServing === null) {
      violations.push({ lineId: line.id, reason: 'beverage_thc_per_serving_missing' });
    } else if (line.thcMgPerServing.greaterThan(MN_BEVERAGE_LIMITS.thcMgPerServingMax)) {
      violations.push({
        lineId: line.id,
        reason: 'beverage_potency_exceeds_cap',
        value: line.thcMgPerServing.toNumber(),
        cap: MN_BEVERAGE_LIMITS.thcMgPerServingMax.toNumber(),
      });
    }

    if (line.servingCount === null) {
      violations.push({ lineId: line.id, reason: 'beverage_serving_count_missing' });
    } else if (line.servingCount > MN_BEVERAGE_LIMITS.servingsPerContainerMax) {
      violations.push({
        lineId: line.id,
        reason: 'beverage_servings_exceeds_cap',
        value: line.servingCount,
        cap: MN_BEVERAGE_LIMITS.servingsPerContainerMax,
      });
    }
  }

  return {
    rule: 'product_provenance',
    passed: violations.length === 0,
    details: { violations },
  };
}
