/**
 * Driver-self app surface (Phase 8.5):
 *
 *   currentRoute(ctx)                — order in flight + pickup + dropoff
 *   earnings(ctx, query, now)        — bucketed tips + fees + deliveries
 *   shifts(ctx)                      — recent shift history
 *
 * Read-only surface — no DB writes, no transactions, no row locks. The
 * driver app polls these on a tick to render dashboard cards; they sit
 * outside the order/offer chokepoints (which own all state mutations).
 *
 * `currentRoute` reads `drivers.current_order_id` (set by the offer
 * accept handler and cleared by the delivery completion handler). When
 * null we return `{ activeOrder: null }` rather than 404 — the driver
 * app polls this to decide whether to render "waiting for offers" vs
 * "drive to pickup", and the in-band null carries more signal than a
 * status code the network layer has to translate.
 *
 * `earnings` buckets are calculated against America/Chicago (matching
 * the dispensary timezone elsewhere in the codebase). A driver whose
 * shift crosses local-midnight sees the earnings flip into the next
 * day's bucket exactly when the local clock does, regardless of the
 * server's UTC offset.
 *
 * `shifts` lists `driver_shifts` rows newest-first. We trust the repo's
 * default cap (50) — the driver app surfaces "recent shifts" only;
 * historic-detail and CSV export go through admin tooling.
 *
 * The DriverContext attached by DriverContextGuard is the only source
 * of `driverId` here. Read-only methods don't re-lock the drivers row —
 * a `current_order_id` flipped to null between guard and read is a
 * benign race (we render no active route until the next tick).
 */
import {
  DispensariesRepository,
  DriverShiftsRepository,
  DriversRepository,
  OrdersRepository,
} from '@dankdash/db';
import { DriverError, RepositoryError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { projectDriverShift } from '../shift/driver-shift.projection.js';
import { projectActiveRoute, projectNoActiveRoute } from './current-route.projection.js';
import {
  type CurrentRouteResponse,
  type EarningsPeriod,
  type EarningsQuery,
  type EarningsResponse,
  type ShiftsListResponse,
} from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

/**
 * Single timezone for all earnings buckets. Matches what compliance and
 * the dispensary hours engine use — keeps "today" consistent across the
 * driver app, customer app, and ops tooling.
 */
const EARNINGS_ZONE = 'America/Chicago';

@Injectable()
export class DriverAppService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly orders: OrdersRepository,
    private readonly dispensaries: DispensariesRepository,
    private readonly driverShifts: DriverShiftsRepository,
  ) {}

  async currentRoute(ctx: DriverContext): Promise<CurrentRouteResponse> {
    const driver = await this.drivers.findById(ctx.driverId);
    if (driver === null) {
      // Driver row vanished between guard and read — caller had a valid
      // driver JWT a moment ago, so treat as forbidden rather than 404.
      throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
        driverId: ctx.driverId,
      });
    }
    if (driver.currentOrderId === null) {
      return projectNoActiveRoute();
    }

    const order = await this.orders.findById(driver.currentOrderId);
    if (order === null) {
      // Order row vanished while the driver still pointed at it — a
      // hard invariant violation. RepositoryError surfaces as 500 with
      // a distinct code so ops can alert; clearing the pointer is the
      // job of the order completion handler, not this read.
      throw new RepositoryError(
        `driver ${ctx.driverId} points at order ${driver.currentOrderId} which does not exist`,
        { driverId: ctx.driverId, orderId: driver.currentOrderId },
      );
    }
    const dispensary = await this.dispensaries.findById(order.dispensaryId);
    if (dispensary === null) {
      throw new RepositoryError(
        `order ${order.id} references dispensary ${order.dispensaryId} which does not exist`,
        { orderId: order.id, dispensaryId: order.dispensaryId },
      );
    }
    return projectActiveRoute(order, dispensary);
  }

  async earnings(
    ctx: DriverContext,
    query: EarningsQuery,
    now: Date = new Date(),
  ): Promise<EarningsResponse> {
    const { period } = query;
    const { since, until } = bucketBounds(period, now);
    const totals = await this.orders.sumDriverEarningsBetween(ctx.driverId, since, until);
    return {
      period,
      since: since.toISOString(),
      until: until.toISOString(),
      tipsCents: totals.tipsCents,
      deliveryFeesCents: totals.deliveryFeesCents,
      deliveriesCount: totals.deliveriesCount,
      totalCents: totals.tipsCents + totals.deliveryFeesCents,
    };
  }

  async shifts(ctx: DriverContext): Promise<ShiftsListResponse> {
    const rows = await this.driverShifts.listForDriver(ctx.driverId);
    return { shifts: rows.map((row) => projectDriverShift(row)) };
  }
}

/**
 * Resolve the earnings period to a half-open `[since, until)` UTC window.
 *
 * Buckets are local-calendar in America/Chicago:
 *   - today: start-of-day local → next start-of-day
 *   - week:  ISO week (Mon 00:00 local → next Mon 00:00 local)
 *   - month: 1st 00:00 local → next 1st 00:00 local
 *
 * Half-open so `today` ends precisely where `tomorrow` begins — a
 * delivery completed at 23:59:59.999 local lands in today's bucket, the
 * one at 00:00:00.000 lands in tomorrow's. Bounds are returned as JS
 * `Date` instants for `sumDriverEarningsBetween` to compare against
 * `orders.delivered_at` (timestamptz, stored UTC).
 *
 * Luxon's `startOf('week')` is Monday-start by default (ISO 8601), which
 * matches how MN cannabis ops scheduling currently buckets driver weeks.
 */
function bucketBounds(period: EarningsPeriod, now: Date): { since: Date; until: Date } {
  const local = DateTime.fromJSDate(now, { zone: EARNINGS_ZONE });
  if (!local.isValid) {
    // Should be unreachable — the zone is hard-coded to a real IANA id —
    // but Luxon's typing forces the check and a wrong-zone build is
    // better surfaced loudly than silently rounded to UTC.
    throw new RepositoryError(`invalid timezone for earnings bucket: ${EARNINGS_ZONE}`, {
      zone: EARNINGS_ZONE,
    });
  }
  switch (period) {
    case 'today': {
      const start = local.startOf('day');
      return { since: start.toJSDate(), until: start.plus({ days: 1 }).toJSDate() };
    }
    case 'week': {
      const start = local.startOf('week');
      return { since: start.toJSDate(), until: start.plus({ weeks: 1 }).toJSDate() };
    }
    case 'month': {
      const start = local.startOf('month');
      return { since: start.toJSDate(), until: start.plus({ months: 1 }).toJSDate() };
    }
  }
}

// Test-only export so the bucket calculation can be validated against
// DST edges without going through the full service surface.
export { bucketBounds as __bucketBounds };
