/**
 * computePayoutPeriod tests. The job's idempotency hinges on these
 * boundaries matching the ledger entries' UTC instants, so DST and
 * timezone edge cases are explicit fixtures rather than parameterized.
 */
import { describe, expect, it } from 'vitest';
import { computePayoutPeriod } from './payout.period.js';

describe('computePayoutPeriod', () => {
  it('returns the previous Central calendar day when the cron fires at 03:00 Central', () => {
    // 2026-05-18 03:00 America/Chicago === 2026-05-18 08:00 UTC (CDT, -05:00)
    const now = new Date('2026-05-18T08:00:00.000Z');
    const period = computePayoutPeriod(now);

    expect(period.periodStartDateStr).toBe('2026-05-17');
    expect(period.periodEndDateStr).toBe('2026-05-18');
    expect(period.periodStartUtc.toISOString()).toBe('2026-05-17T05:00:00.000Z');
    expect(period.periodEndUtc.toISOString()).toBe('2026-05-18T05:00:00.000Z');
  });

  it('uses CST offset (-06:00) in winter and CDT offset (-05:00) in summer', () => {
    const winter = computePayoutPeriod(new Date('2026-01-15T09:00:00.000Z'));
    expect(winter.periodStartUtc.toISOString()).toBe('2026-01-14T06:00:00.000Z');
    expect(winter.periodEndUtc.toISOString()).toBe('2026-01-15T06:00:00.000Z');

    const summer = computePayoutPeriod(new Date('2026-07-15T08:00:00.000Z'));
    expect(summer.periodStartUtc.toISOString()).toBe('2026-07-14T05:00:00.000Z');
    expect(summer.periodEndUtc.toISOString()).toBe('2026-07-15T05:00:00.000Z');
  });

  it('handles spring-forward (CST→CDT) — the period spanning the skipped hour is 23h, not 24h', () => {
    // DST forward in 2026 is 2026-03-08 02:00→03:00 Central. A run at
    // 03:00 Central on 2026-03-09 covers 2026-03-08 00:00 CST to
    // 2026-03-09 00:00 CDT.
    const period = computePayoutPeriod(new Date('2026-03-09T08:00:00.000Z'));
    expect(period.periodStartDateStr).toBe('2026-03-08');
    expect(period.periodEndDateStr).toBe('2026-03-09');
    // Start at 00:00 CST = 06:00 UTC; end at 00:00 CDT = 05:00 UTC
    expect(period.periodStartUtc.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(period.periodEndUtc.toISOString()).toBe('2026-03-09T05:00:00.000Z');
    const elapsedHours =
      (period.periodEndUtc.getTime() - period.periodStartUtc.getTime()) / (60 * 60 * 1000);
    expect(elapsedHours).toBe(23);
  });

  it('handles fall-back (CDT→CST) — the period containing the repeated hour is 25h', () => {
    // DST back in 2026: 2026-11-01 02:00→01:00 Central. A run at 03:00
    // Central on 2026-11-02 covers 2026-11-01 00:00 CDT to 2026-11-02
    // 00:00 CST.
    const period = computePayoutPeriod(new Date('2026-11-02T09:00:00.000Z'));
    expect(period.periodStartDateStr).toBe('2026-11-01');
    expect(period.periodEndDateStr).toBe('2026-11-02');
    expect(period.periodStartUtc.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(period.periodEndUtc.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    const elapsedHours =
      (period.periodEndUtc.getTime() - period.periodStartUtc.getTime()) / (60 * 60 * 1000);
    expect(elapsedHours).toBe(25);
  });

  it('treats any instant during a Central calendar day as belonging to the same look-back window', () => {
    const noon = computePayoutPeriod(new Date('2026-05-18T17:00:00.000Z')); // 12:00 CDT
    const justBeforeMidnightCentral = computePayoutPeriod(new Date('2026-05-19T04:59:59.000Z')); // 23:59:59 CDT

    expect(noon.periodEndDateStr).toBe('2026-05-18');
    expect(justBeforeMidnightCentral.periodEndDateStr).toBe('2026-05-18');
  });

  it('rolls to the next look-back window precisely at 00:00 Central', () => {
    // 00:00 CDT on 2026-05-18 === 05:00 UTC on 2026-05-18
    const beforeMidnight = computePayoutPeriod(new Date('2026-05-18T04:59:59.000Z'));
    const atMidnight = computePayoutPeriod(new Date('2026-05-18T05:00:00.000Z'));

    expect(beforeMidnight.periodEndDateStr).toBe('2026-05-17');
    expect(atMidnight.periodEndDateStr).toBe('2026-05-18');
  });
});
