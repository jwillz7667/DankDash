/**
 * Driver earnings aggregation — bucket → window → SUM(tip + fee).
 *
 * The three buckets resolve to the following `[since, until)` half-open
 * windows in America/Chicago:
 *
 *   today  → [00:00 today,                00:00 tomorrow)
 *   week   → [00:00 ISO-Monday-this-week, 00:00 ISO-Monday-next-week)
 *   month  → [00:00 1st-of-this-month,    00:00 1st-of-next-month)
 *
 * "Now" is taken from the injected `clock` callable, mirroring the
 * AuthService / MfaService pattern; tests pin a deterministic instant
 * by passing a fixed-result thunk and never need to fake `Date`
 * globally. Bounds are computed in America/Chicago and converted back
 * to UTC for the DB predicate — `orders.delivered_at` is timestamptz,
 * so the comparison is in UTC.
 *
 * The aggregate itself lives in `OrdersRepository.sumDriverEarnings` so
 * the SQL is reviewed alongside the rest of the order read surface;
 * this service is the period-policy seam.
 *
 * Returned `since` / `until` are the *same* America/Chicago wall-clock
 * instants we queried with — the client renders them verbatim (e.g.
 * "Today (May 19)") and never re-derives the window from the device
 * clock. See `EarningsPeriodSchema` in
 * `apps/api/src/modules/drivers/dto/earnings.dto.ts` for the wire-shape
 * commentary.
 */
import { type Database, type OrdersRepository } from '@dankdash/db';
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  DriverEarningsResponseSchema,
  type DriverEarningsResponse,
  type EarningsPeriod,
} from '../dto/index.js';

const ZONE = 'America/Chicago';

export interface DriverEarningsScopedRepos {
  readonly orders: OrdersRepository;
}

export type DriverEarningsScopedReposFactory = (db: Database) => DriverEarningsScopedRepos;

export interface DriverEarningsServiceConfig {
  /** Clock injection for deterministic tests. */
  readonly clock?: () => Date;
}

@Injectable()
export class DriverEarningsService {
  private readonly clock: () => Date;

  constructor(
    private readonly db: Database,
    private readonly reposFor: DriverEarningsScopedReposFactory,
    config: DriverEarningsServiceConfig = {},
  ) {
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async getEarnings(driverUserId: string, period: EarningsPeriod): Promise<DriverEarningsResponse> {
    const { since, until } = computeWindow(period, this.clock());
    const scoped = this.reposFor(this.db);
    const aggregate = await scoped.orders.sumDriverEarnings({
      driverId: driverUserId,
      since: since.toJSDate(),
      until: until.toJSDate(),
    });
    return DriverEarningsResponseSchema.parse({
      period,
      // `toJSDate().toISOString()` is guaranteed non-null for a
      // DateTime built from a valid JS Date — using it (over
      // `luxon.toISO()`, which is `string | null`) keeps the surface
      // total and removes a non-null assertion. The wire emits UTC
      // (`Z` suffix); the iOS client formats it back to America/Chicago
      // for the user-visible "Today (May 19)" label.
      since: since.toJSDate().toISOString(),
      until: until.toJSDate().toISOString(),
      tipsCents: aggregate.tipsCents,
      deliveryFeesCents: aggregate.deliveryFeesCents,
      deliveriesCount: aggregate.deliveriesCount,
      totalCents: aggregate.tipsCents + aggregate.deliveryFeesCents,
    });
  }
}

/**
 * `now` is a UTC JS Date; we reframe to America/Chicago for the
 * start-of-day / start-of-week / start-of-month boundary, then leave
 * the result as a zoned `DateTime` (the caller serializes it with the
 * zone offset preserved). Exported for use by the cashout service,
 * which uses the lifetime window: `since=null`, `until=now`.
 */
export function computeWindow(
  period: EarningsPeriod,
  now: Date,
): { readonly since: DateTime; readonly until: DateTime } {
  const localNow = DateTime.fromJSDate(now, { zone: ZONE });
  if (period === 'today') {
    const since = localNow.startOf('day');
    return { since, until: since.plus({ days: 1 }) };
  }
  if (period === 'week') {
    // luxon's `startOf('week')` is ISO-week (Monday-start), which
    // matches the spec's "this week" framing for delivery drivers.
    const since = localNow.startOf('week');
    return { since, until: since.plus({ weeks: 1 }) };
  }
  const since = localNow.startOf('month');
  return { since, until: since.plus({ months: 1 }) };
}
