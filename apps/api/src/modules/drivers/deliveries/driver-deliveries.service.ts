/**
 * Open-pool delivery orchestration (driver-facing).
 *
 *   listAvailable(ctx) — every order in `awaiting_driver` whose
 *     dispensary is within the dispatch radius of the requesting driver.
 *     This is the shared claimable board, NOT a per-driver targeted
 *     offer. A busy (mid-delivery) or offline driver gets an empty list:
 *     they can't take a second order, so showing the pool would only
 *     invite a guaranteed 409 on claim. No lock — a stale read here
 *     self-heals on the next poll or surfaces as a 409 at claim time.
 *
 *   claim(ctx, orderId) — first-come atomic claim. Same transaction
 *     discipline as {@link DriverOffersService.accept}, minus the
 *     dispatch_offers row (the open pool has none to validate):
 *       1. Lock the driver row FOR UPDATE, validate online + no current
 *          order.
 *       2. Route DRIVER_ASSIGNED through `OrderTransitionService.
 *          transitionWithinTx` — this locks the order row and runs the
 *          XState guard, which requires `awaiting_driver`. A second
 *          driver racing the same order serialises behind the order-row
 *          lock and sees `driver_assigned`; the machine rejects with
 *          ORDER_INVALID_TRANSITION → we translate to a 409 so the loser
 *          gets a clean "another driver grabbed it". An order that was
 *          canceled / rejected out of `awaiting_driver` fails the same
 *          way (correctly — it's no longer claimable).
 *       3. Stamp `drivers.current_order_id` + flip driver status to
 *          `en_route_pickup` (committed to driving to the dispensary).
 *       4. Expire any stray `dispatch_offers` for the order — defensive
 *          for a window where the open-pool flag and legacy targeting
 *          briefly co-exist; a pure open-pool order has none.
 *
 * The `OrderTransitionedEvent` is emitted AFTER the outer tx commits so
 * realtime / notification subscribers never react to a transition the DB
 * later rolled back. The same post-commit emit drives the
 * `delivery:claimed` fan-out that clears the pin from every other
 * dasher's map (see apps/realtime/src/streams/router.ts).
 */
import { type Database, DispatchOffersRepository, DriversRepository } from '@dankdash/db';
import { OrderError } from '@dankdash/orders';
import { DriverError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { OrderTransitionService } from '../../orders/order-transition.service.js';
import { projectAvailableDelivery } from './available-delivery.projection.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type { AvailableDeliveriesResponse, ClaimDeliveryResponse } from './dto/index.js';

export interface DriverDeliveriesScopedRepos {
  readonly dispatchOffers: DispatchOffersRepository;
  readonly drivers: DriversRepository;
}
export type DriverDeliveriesScopedReposFactory = (db: Database) => DriverDeliveriesScopedRepos;

@Injectable()
export class DriverDeliveriesService {
  private readonly logger = new Logger(DriverDeliveriesService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly orderTransitions: OrderTransitionService,
    private readonly scopedReposFor: DriverDeliveriesScopedReposFactory,
    private readonly maxRadiusMeters: number,
  ) {}

  async listAvailable(ctx: DriverContext): Promise<AvailableDeliveriesResponse> {
    // A driver already on a delivery, or not online, can't take a new
    // one — return an empty board rather than tempt a guaranteed 409.
    if (ctx.currentOrderId !== null || ctx.currentStatus !== 'online') {
      return { deliveries: [] };
    }
    const repos = this.scopedReposFor(this.db);
    const rows = await repos.dispatchOffers.listAvailableDeliveries(
      ctx.driverId,
      this.maxRadiusMeters,
    );
    return { deliveries: rows.map(projectAvailableDelivery) };
  }

  async claim(
    ctx: DriverContext,
    orderId: string,
    now: Date = new Date(),
  ): Promise<ClaimDeliveryResponse> {
    const outcome = await this.db.transaction(async (tx) => {
      const repos = this.scopedReposFor(tx);

      const driver = await repos.drivers.findByIdForUpdate(ctx.driverId);
      if (driver === null) {
        throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
          driverId: ctx.driverId,
        });
      }
      if (driver.currentOrderId !== null) {
        throw new DriverError(
          'DRIVER_BUSY_WITH_ORDER',
          'cannot claim while assigned to another order',
          { driverId: ctx.driverId, currentOrderId: driver.currentOrderId },
        );
      }
      if (driver.currentStatus !== 'online') {
        throw new DriverError(
          'DRIVER_NOT_ONLINE',
          `cannot claim a delivery from status ${driver.currentStatus}`,
          { driverId: ctx.driverId, currentStatus: driver.currentStatus },
        );
      }

      let transition;
      try {
        transition = await this.orderTransitions.transitionWithinTx(
          {
            orderId,
            event: 'DRIVER_ASSIGNED',
            actor: { role: 'system' },
            patch: { driverId: ctx.userId },
            reason: 'driver claimed open-pool delivery',
            payload: { driverId: ctx.driverId, source: 'open_pool' },
          },
          tx,
        );
      } catch (err) {
        throw this.translateClaimError(err, orderId, ctx);
      }

      await repos.dispatchOffers.expireAllActiveForOrder(orderId, now);
      await repos.drivers.setCurrentOrder(ctx.driverId, orderId);
      await repos.drivers.setStatus(ctx.driverId, 'en_route_pickup');

      return {
        orderId,
        status: transition.result.toStatus,
        deferredEvent: transition.deferredEvent,
      };
    });

    this.orderTransitions.emitDeferred(outcome.deferredEvent);
    this.logger.log(
      { orderId: outcome.orderId, driverId: ctx.driverId, status: outcome.status },
      'open-pool delivery claimed',
    );
    return { orderId: outcome.orderId, status: outcome.status };
  }

  /**
   * Map the order-transition failures a claim can hit onto driver-domain
   * errors with the right HTTP semantics:
   *   - the order left `awaiting_driver` (another driver won, or it was
   *     canceled/rejected) → 409 DRIVER_DELIVERY_ALREADY_CLAIMED, which
   *     the dasher app renders as "another driver grabbed it" and drops
   *     the pin.
   *   - the order id doesn't exist → 404 DRIVER_DELIVERY_NOT_AVAILABLE.
   * Any other error (programmer bug, DB failure) propagates untouched.
   */
  private translateClaimError(err: unknown, orderId: string, ctx: DriverContext): unknown {
    if (err instanceof OrderError) {
      if (err.code === 'ORDER_INVALID_TRANSITION' || err.code === 'ORDER_TERMINAL_STATE') {
        return new DriverError(
          'DRIVER_DELIVERY_ALREADY_CLAIMED',
          'this delivery is no longer available',
          { orderId, driverId: ctx.driverId },
          err,
        );
      }
      if (err.code === 'ORDER_NOT_FOUND') {
        return new DriverError(
          'DRIVER_DELIVERY_NOT_AVAILABLE',
          `delivery ${orderId} not found`,
          { orderId },
          err,
        );
      }
    }
    return err;
  }
}
