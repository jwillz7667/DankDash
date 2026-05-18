/**
 * KYC rule.
 *
 * The applicant must have a Persona-verified KYC inquiry on file. Mirrors
 * the boolean projected onto `users.kyc_verified_at` after the
 * `inquiry.completed` webhook is applied (see PHASE 2 — Identity).
 *
 * A null `kycVerifiedAt` fails; any non-null value (even one from years
 * ago) passes. Per-cart KYC freshness — e.g. re-verify after N months —
 * is a separate decision and not in scope for this rule today.
 */
import type { EvaluationContext, RuleResult } from '../types.js';

export function checkKyc(ctx: EvaluationContext): RuleResult {
  const verifiedAt = ctx.user.kycVerifiedAt;
  const verified = verifiedAt !== null;
  return {
    rule: 'kyc',
    passed: verified,
    details: {
      verified,
      verifiedAt: verifiedAt === null ? null : verifiedAt.toISOString(),
    },
  };
}
