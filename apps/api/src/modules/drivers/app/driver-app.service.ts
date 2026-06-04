/**
 * Driver-self app surface (Phase 8.5):
 *
 *   currentRoute(ctx)                — order in flight + pickup + dropoff
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
 * `shifts` lists `driver_shifts` rows newest-first. We trust the repo's
 * default cap (50) — the driver app surfaces "recent shifts" only;
 * historic-detail and CSV export go through admin tooling.
 *
 * Earnings is intentionally NOT served here: it keys on the principal's
 * `users.id` (what `orders.driver_id` references), whereas this surface
 * only carries the `drivers.id` from `DriverContext`. The bucketed
 * earnings projection lives in `DriverEarningsService` /
 * `DriverEarningsController` alongside the cashout/wallet surface.
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
import { projectDriverShift } from '../shift/driver-shift.projection.js';
import { projectActiveRoute, projectNoActiveRoute } from './current-route.projection.js';
import { type CurrentRouteResponse, type ShiftsListResponse } from './dto/index.js';
import type { DriverContext } from '../context/driver-context.types.js';

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

  async shifts(ctx: DriverContext): Promise<ShiftsListResponse> {
    const rows = await this.driverShifts.listForDriver(ctx.driverId);
    return { shifts: rows.map((row) => projectDriverShift(row)) };
  }
}
