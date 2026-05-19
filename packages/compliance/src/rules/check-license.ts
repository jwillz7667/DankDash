/**
 * Dispensary license rule.
 *
 * The selling dispensary must hold an unexpired MN OCM cannabis license at
 * the moment of evaluation. License expiration is a half-open boundary:
 * `expiresAt > now` passes, `expiresAt <= now` fails. A license whose
 * `expiresAt` is exactly the current instant is treated as expired.
 *
 * The repository layer is the source of truth for `licenseExpiresAt`; the
 * background renewal job (PHASE 4) refreshes it from MN OCM weekly. If the
 * field is stale beyond the renewal cadence, that is a worker outage to
 * alert on, not something this rule can detect.
 */
import type { EvaluationContext, RuleResult } from '../types.js';

export function checkLicense(ctx: EvaluationContext, now: Date): RuleResult {
  const expires = ctx.dispensary.licenseExpiresAt;
  return {
    rule: 'dispensary_license',
    passed: expires.getTime() > now.getTime(),
    details: {
      expiresAt: expires.toISOString(),
      now: now.toISOString(),
    },
  };
}
