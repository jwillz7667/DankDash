/**
 * @dankdash/compliance public surface.
 *
 * Consumers import only from this barrel. The iOS client also depends on
 * these exports (via the generated TS types in `packages/types`) for its
 * UX preview, so additions here are also a client API change — bump the
 * compliance package version and run a quick check against the iOS
 * `ComplianceClient` before landing.
 */
export {
  COMPLIANCE_EVALUATION_VERSION,
  MN_BEVERAGE_LIMITS,
  MN_DEFAULT_TIMEZONE,
  MN_MINIMUM_AGE_YEARS,
  MN_PER_TRANSACTION_LIMITS,
  MN_SALES_HOURS,
} from './constants.js';
export type {
  CartLine,
  CartTotals,
  ComplianceEvaluation,
  ComplianceLimitsSnapshot,
  ComplianceTotalsSnapshot,
  DayHours,
  DispensaryHours,
  EvaluationContext,
  EvaluationDispensary,
  EvaluationLocation,
  EvaluationUser,
  ProductType,
  RuleDetails,
  RuleId,
  RuleResult,
  Weekday,
} from './types.js';
export { computeCartTotals, totalsToSnapshot } from './cart-math.js';
export { pointInPolygon, type Coordinate } from './geo.js';
export { evaluateCart } from './evaluate.js';
export { checkAge } from './rules/check-age.js';
export { checkGeofence } from './rules/check-geofence.js';
export { checkHours } from './rules/check-hours.js';
export { checkKyc } from './rules/check-kyc.js';
export { checkLicense } from './rules/check-license.js';
export { checkPerTransactionLimits } from './rules/check-per-transaction-limits.js';
export { checkProductProvenance } from './rules/check-product-provenance.js';
