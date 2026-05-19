/**
 * Compute the [periodStart, periodEnd) window for a daily payout run.
 *
 * The window covers the previous calendar day in America/Chicago — that is,
 * if the cron fires at 03:00 Central on 2026-05-18, the period covers
 * 2026-05-17 00:00:00 Central through 2026-05-18 00:00:00 Central. This
 * keeps the payout aligned with how vendors and drivers think about a
 * "business day" rather than slicing on the UTC calendar.
 *
 * Boundary semantics:
 *   - periodStartCentral: 00:00:00 the previous Central day (inclusive)
 *   - periodEndCentral:   00:00:00 the run-day Central (EXCLUSIVE)
 *   - periodStartUtc / periodEndUtc: the same instants converted to UTC
 *     for the ledger query
 *   - periodStartDateStr / periodEndDateStr: ISO YYYY-MM-DD for the
 *     `payouts.period_start` / `period_end` `date` columns
 *
 * DST: luxon handles the spring-forward / fall-back hour correctly —
 * `startOf('day')` in zone always lands at 00:00 local. The exclusive
 * upper bound means an order whose ledger entry occurredAt is precisely
 * the boundary belongs to the *next* day's payout. Tested explicitly.
 */
import { DateTime } from 'luxon';

export const PAYOUT_TIMEZONE = 'America/Chicago';

export interface PayoutPeriod {
  readonly periodStartUtc: Date;
  readonly periodEndUtc: Date;
  readonly periodStartDateStr: string;
  readonly periodEndDateStr: string;
}

/**
 * @param now The instant the cron fired (typically `new Date()` in prod;
 *            a fixed clock in tests). Anything inside the run-day Central
 *            calendar maps to the same window — we always look back at
 *            the previous Central day.
 */
export function computePayoutPeriod(now: Date): PayoutPeriod {
  const runInCentral = DateTime.fromJSDate(now, { zone: PAYOUT_TIMEZONE });
  const runDayStart = runInCentral.startOf('day');
  const prevDayStart = runDayStart.minus({ days: 1 });

  return {
    periodStartUtc: prevDayStart.toUTC().toJSDate(),
    periodEndUtc: runDayStart.toUTC().toJSDate(),
    periodStartDateStr: prevDayStart.toISODate() ?? '',
    periodEndDateStr: runDayStart.toISODate() ?? '',
  };
}
