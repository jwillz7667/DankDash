/**
 * Per-transaction limit rule — Minn. Stat. § 342.27, subd. (c)(1)–(3).
 *
 * Aggregates cart lines into the three caps (flower, concentrate,
 * edible THC) via the cart-math layer and compares each total against
 * the statutory maximum using Decimal `>` semantics. The cap is
 * inclusive — a cart that hits the limit exactly passes; one that
 * exceeds by any amount fails.
 *
 * `details.violations` lists the failing categories so the iOS client
 * can render a precise "you're over by N grams of flower" message. The
 * totals and limits are echoed back as plain numbers in the snapshot
 * shape so the evaluation can be persisted to
 * `orders.compliance_check_payload` directly.
 */
import { computeCartTotals, totalsToSnapshot } from '../cart-math.js';
import { MN_PER_TRANSACTION_LIMITS } from '../constants.js';
import type { EvaluationContext, RuleResult } from '../types.js';

const LIMITS_SNAPSHOT = {
  flowerGramsMax: MN_PER_TRANSACTION_LIMITS.flowerGramsMax.toNumber(),
  concentrateGramsMax: MN_PER_TRANSACTION_LIMITS.concentrateGramsMax.toNumber(),
  edibleThcMgMax: MN_PER_TRANSACTION_LIMITS.edibleThcMgMax.toNumber(),
} as const;

export function checkPerTransactionLimits(ctx: EvaluationContext): RuleResult {
  const totals = computeCartTotals(ctx.cart);
  const violations: string[] = [];

  if (totals.flowerGrams.greaterThan(MN_PER_TRANSACTION_LIMITS.flowerGramsMax)) {
    violations.push('flower');
  }
  if (totals.concentrateGrams.greaterThan(MN_PER_TRANSACTION_LIMITS.concentrateGramsMax)) {
    violations.push('concentrate');
  }
  if (totals.edibleThcMg.greaterThan(MN_PER_TRANSACTION_LIMITS.edibleThcMgMax)) {
    violations.push('edibles');
  }

  return {
    rule: 'per_transaction_limit',
    passed: violations.length === 0,
    details: {
      totals: totalsToSnapshot(totals),
      limits: LIMITS_SNAPSHOT,
      violations,
    },
  };
}
