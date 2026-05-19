/**
 * Age rule — Minn. Stat. § 342.46.
 *
 * The applicant must be at least 21 years old at the moment of evaluation.
 * "21 years old" is interpreted as a fractional-year difference of >= 21.0,
 * which is true on and after the user's 21st birthday. A 20-years-364-days
 * cart fails.
 *
 * Three failure modes are distinguished in `details.reason`:
 *   - `dob_missing` — the user record has no DOB on file (pre-KYC or data
 *     corruption). Always fail; downstream surfacing converts this to
 *     COMPLIANCE_AGE_REQUIRED so the iOS client routes to KYC start.
 *   - `future_dob` — DOB is in the future. Treated as data corruption; we
 *     fail closed and emit the value so ops can investigate.
 *   - (none) — the rule reached an age comparison; `passed` reflects whether
 *     the user is of age and `details.age` is the floor of their age in years.
 */
import { DateTime } from 'luxon';
import { MN_MINIMUM_AGE_YEARS } from '../constants.js';
import type { EvaluationContext, RuleResult } from '../types.js';

export function checkAge(ctx: EvaluationContext, now: Date): RuleResult {
  const dob = ctx.user.dateOfBirth;
  if (dob === null) {
    return {
      rule: 'age',
      passed: false,
      details: { reason: 'dob_missing', minimum: MN_MINIMUM_AGE_YEARS },
    };
  }

  const nowDt = DateTime.fromJSDate(now);
  const dobDt = DateTime.fromJSDate(dob);

  if (dobDt > nowDt) {
    return {
      rule: 'age',
      passed: false,
      details: {
        reason: 'future_dob',
        dateOfBirth: dobDt.toUTC().toISO(),
        minimum: MN_MINIMUM_AGE_YEARS,
      },
    };
  }

  const ageYears = nowDt.diff(dobDt, 'years').years;
  return {
    rule: 'age',
    passed: ageYears >= MN_MINIMUM_AGE_YEARS,
    details: { age: Math.floor(ageYears), minimum: MN_MINIMUM_AGE_YEARS },
  };
}
