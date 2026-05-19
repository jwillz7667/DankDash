/**
 * Top-level cart-evaluation composer.
 *
 * Runs every rule in a fixed order against a shared `now` so all rules see
 * the same wall clock, aggregates the cart once for the snapshot, and
 * returns the `ComplianceEvaluation` that persists to
 * `orders.compliance_check_payload`.
 *
 * Fail-closed semantics: an exception escaping any rule (a programmer error
 * or upstream data corruption) is caught here and converted to a result
 * with `passed: false` and an `evaluation` sentinel in `rules[]`. The
 * engine never returns `passed: true` on an exception path; auditors can
 * always tell a fail-closed evaluation from a normal pass/fail by the
 * presence of the `evaluation` rule with `details.reason ===
 * 'evaluation_exception'`.
 *
 * Rule order is significant for snapshot readability (identity → license →
 * time → place → cart contents) but does not affect the pass/fail outcome
 * — every rule runs every time, regardless of earlier failures, so the
 * client gets a complete failure list in a single round trip.
 */
import { computeCartTotals, totalsToSnapshot } from './cart-math.js';
import { COMPLIANCE_EVALUATION_VERSION, MN_PER_TRANSACTION_LIMITS } from './constants.js';
import { checkAge } from './rules/check-age.js';
import { checkGeofence } from './rules/check-geofence.js';
import { checkHours } from './rules/check-hours.js';
import { checkKyc } from './rules/check-kyc.js';
import { checkLicense } from './rules/check-license.js';
import { checkPerTransactionLimits } from './rules/check-per-transaction-limits.js';
import { checkProductProvenance } from './rules/check-product-provenance.js';
import type {
  ComplianceEvaluation,
  ComplianceLimitsSnapshot,
  ComplianceTotalsSnapshot,
  EvaluationContext,
  RuleResult,
} from './types.js';

const LIMITS_SNAPSHOT: ComplianceLimitsSnapshot = {
  flowerGramsMax: MN_PER_TRANSACTION_LIMITS.flowerGramsMax.toNumber(),
  concentrateGramsMax: MN_PER_TRANSACTION_LIMITS.concentrateGramsMax.toNumber(),
  edibleThcMgMax: MN_PER_TRANSACTION_LIMITS.edibleThcMgMax.toNumber(),
};

const ZERO_TOTALS: ComplianceTotalsSnapshot = {
  flowerGrams: 0,
  concentrateGrams: 0,
  edibleThcMg: 0,
};

export function evaluateCart(ctx: EvaluationContext): ComplianceEvaluation {
  const now = ctx.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const results: RuleResult[] = [];
  let totals: ComplianceTotalsSnapshot;

  try {
    results.push(checkAge(ctx, now));
    results.push(checkKyc(ctx));
    results.push(checkLicense(ctx, now));
    results.push(checkHours(ctx, now));
    results.push(checkGeofence(ctx));
    results.push(checkPerTransactionLimits(ctx));
    results.push(checkProductProvenance(ctx));
    totals = totalsToSnapshot(computeCartTotals(ctx.cart));
  } catch (err) {
    results.push({
      rule: 'evaluation',
      passed: false,
      details: {
        reason: 'evaluation_exception',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return {
      passed: false,
      rules: results,
      cartTotals: ZERO_TOTALS,
      limits: LIMITS_SNAPSHOT,
      evaluatedAt,
      evaluationVersion: COMPLIANCE_EVALUATION_VERSION,
    };
  }

  return {
    passed: results.every((r) => r.passed),
    rules: results,
    cartTotals: totals,
    limits: LIMITS_SNAPSHOT,
    evaluatedAt,
    evaluationVersion: COMPLIANCE_EVALUATION_VERSION,
  };
}
