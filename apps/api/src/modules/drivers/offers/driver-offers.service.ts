/**
 * Driver-self dispatch-offer accept/decline orchestration (Phase 8.4).
 *
 *   accept(ctx, offerId)  — driver claims a still-open offer. Atomically:
 *     1. SELECT … FOR UPDATE the offer row, validate (owner, status,
 *        not expired).
 *     2. SELECT … FOR UPDATE the driver row, validate (no current
 *        order, currently `online`).
 *     3. Route DRIVER_ASSIGNED through `OrderTransitionService.
 *        transitionWithinTx` — this locks the order row, runs the
 *        XState machine guard (must be `awaiting_driver`), updates
 *        `orders.status` + `orders.driver_id`, and inserts the
 *        immutable `order_events` + `order_status_history` rows. A
 *        concurrent customer cancel / vendor reject that flipped the
 *        order out of `awaiting_driver` surfaces here as
 *        ORDER_INVALID_TRANSITION and rolls the outer tx back, leaving
 *        the offer untouched.
 *     4. Mark the offer `accepted`. The repo's atomic
 *        `WHERE status = 'offered'` serialises any racing accept; the
 *        FOR UPDATE in step 1 plus this check make double-accept
 *        impossible at both the SQL and lock levels.
 *     5. Bulk-expire every sibling offer for the same order — those
 *        drivers lost the race; the partial index drops them so they
 *        stop appearing in "my active offers".
 *     6. Stamp `drivers.current_order_id` + flip status to
 *        `en_route_pickup` (the driver is now committed to driving to
 *        the dispensary; the order transitions to `en_route_pickup`
 *        later when the driver hits "start trip" in the app).
 *
 *   decline(ctx, offerId, { reason }) — driver passes on the offer.
 *     Same lock + validation as accept (without the driver-state
 *     check), then flips the offer to `declined` with the optional
 *     reason. Sibling offers are NOT cancelled — the dispatch worker's
 *     next tick will issue the next-best driver.
 *
 * Both flows defer their event emission to AFTER the outer tx commits,
 * so subscribers (realtime push, notifications, customer "your driver
 * is on the way") never react to a transition the DB later rolled back.
 *
 * Lock-order discipline: offer → driver → order. The dispatch worker
 * locks only the order; the driver-self surface (shift, status) locks
 * only the driver. No flow takes locks in the opposite order, so the
 * accept path cannot deadlock with concurrent worker ticks or driver
 * shift mutations.
 */
import {
  type Database,
  type DispatchOffer,
  DispatchOffersRepository,
  DriversRepository,
} from '@dankdash/db';
import { DriverError } from '@dankdash/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DRIZZLE_DB } from '../../../infrastructure/drizzle.module.js';
import { OrderTransitionService } from '../../orders/order-transition.service.js';
import { projectDispatchOffer } from './dispatch-offer.projection.js';
import {
  OFFER_ACCEPTED_EVENT,
  OFFER_DECLINED_EVENT,
  OfferAcceptedEvent,
  OfferDeclinedEvent,
} from './offer.events.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type {
  DeclineOfferRequest,
  DispatchOfferResponse,
  PendingOffersResponse,
} from './dto/index.js';

export interface DriverOffersScopedRepos {
  readonly dispatchOffers: DispatchOffersRepository;
  readonly drivers: DriversRepository;
}
export type DriverOffersScopedReposFactory = (db: Database) => DriverOffersScopedRepos;

@Injectable()
export class DriverOffersService {
  private readonly logger = new Logger(DriverOffersService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly orderTransitions: OrderTransitionService,
    private readonly scopedReposFor: DriverOffersScopedReposFactory,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * GET /v1/driver/offers/pending. The driver app's polling fallback
   * for offer delivery (the `/driver` Socket.io namespace is the
   * future push channel). Returns only this driver's still-`offered`,
   * non-expired rows — `listActiveForDriver` filters on
   * `driver_id = ctx.driverId AND status = 'offered' AND expires_at >
   * now`, newest-first. No lock: a stale read here is self-correcting
   * (the accept path re-validates the offer under FOR UPDATE), and the
   * 30-second countdown UI re-polls every 10s regardless.
   *
   * Wrapped in `{ offers }` so a future page-cursor is non-breaking.
   */
  async listPending(ctx: DriverContext, now: Date = new Date()): Promise<PendingOffersResponse> {
    const repos = this.scopedReposFor(this.db);
    const offers = await repos.dispatchOffers.listActiveForDriver(ctx.driverId, now);
    return { offers: offers.map(projectDispatchOffer) };
  }

  async accept(
    ctx: DriverContext,
    offerId: string,
    now: Date = new Date(),
  ): Promise<DispatchOfferResponse> {
    const outcome = await this.db.transaction(async (tx) => {
      const repos = this.scopedReposFor(tx);

      const offer = await repos.dispatchOffers.findByIdForUpdate(offerId);
      this.guardOfferOwnership(offer, offerId, ctx);
      // `guardOfferOwnership` is an `asserts offer is DispatchOffer` —
      // narrows the local automatically; no extra cast needed.
      if (offer.status !== 'offered') {
        throw new DriverError(
          'DRIVER_OFFER_ALREADY_RESPONDED',
          `offer is already ${offer.status}`,
          { offerId, status: offer.status },
        );
      }
      if (offer.expiresAt.getTime() <= now.getTime()) {
        throw new DriverError('DRIVER_OFFER_EXPIRED', 'offer has expired', {
          offerId,
          expiresAt: offer.expiresAt.toISOString(),
          now: now.toISOString(),
        });
      }

      const driver = await repos.drivers.findByIdForUpdate(ctx.driverId);
      if (driver === null) {
        throw new DriverError('DRIVER_NOT_FOUND', 'driver row no longer exists', {
          driverId: ctx.driverId,
        });
      }
      if (driver.currentOrderId !== null) {
        throw new DriverError(
          'DRIVER_BUSY_WITH_ORDER',
          'cannot accept while assigned to another order',
          { driverId: ctx.driverId, currentOrderId: driver.currentOrderId },
        );
      }
      if (driver.currentStatus !== 'online') {
        throw new DriverError(
          'DRIVER_NOT_ONLINE',
          `cannot accept offer from status ${driver.currentStatus}`,
          { driverId: ctx.driverId, currentStatus: driver.currentStatus },
        );
      }

      // Route DRIVER_ASSIGNED through the order transition chokepoint
      // — concurrent CUSTOMER_CANCEL / STORE_CANCEL / DISPATCH_FAILED
      // surfaces here as ORDER_INVALID_TRANSITION and rolls the outer
      // tx back, leaving the offer in `offered` status for the next
      // worker tick to retry against the new state.
      const orderTransition = await this.orderTransitions.transitionWithinTx(
        {
          orderId: offer.orderId,
          event: 'DRIVER_ASSIGNED',
          actor: { role: 'system' },
          patch: { driverId: ctx.userId },
          reason: 'driver accepted dispatch offer',
          payload: { offerId, driverId: ctx.driverId },
        },
        tx,
      );

      const accepted = await repos.dispatchOffers.respond(offerId, 'accepted', now);
      if (accepted === null) {
        // Lock said `offered` but the conditional UPDATE matched zero rows
        // — only reachable if a sibling tx slipped a respond() through
        // between our FOR UPDATE and our UPDATE on the same row, which the
        // lock should prevent. Treat as the conflict it would represent.
        throw new DriverError(
          'DRIVER_OFFER_ALREADY_RESPONDED',
          'offer status changed between lock and update',
          { offerId },
        );
      }

      await repos.dispatchOffers.expireOtherActiveForOrder(offer.orderId, offerId, now);

      await repos.drivers.setCurrentOrder(ctx.driverId, offer.orderId);
      await repos.drivers.setStatus(ctx.driverId, 'en_route_pickup');

      return { acceptedOffer: accepted, orderTransitionEvent: orderTransition.deferredEvent };
    });

    this.orderTransitions.emitDeferred(outcome.orderTransitionEvent);
    this.emitOfferAccepted(outcome.acceptedOffer, ctx.userId, now);
    return projectDispatchOffer(outcome.acceptedOffer);
  }

  async decline(
    ctx: DriverContext,
    offerId: string,
    body: DeclineOfferRequest,
    now: Date = new Date(),
  ): Promise<DispatchOfferResponse> {
    const reason = body.reason ?? null;
    const declined = await this.db.transaction(async (tx) => {
      const repos = this.scopedReposFor(tx);

      const offer = await repos.dispatchOffers.findByIdForUpdate(offerId);
      this.guardOfferOwnership(offer, offerId, ctx);
      if (offer.status !== 'offered') {
        throw new DriverError(
          'DRIVER_OFFER_ALREADY_RESPONDED',
          `offer is already ${offer.status}`,
          { offerId, status: offer.status },
        );
      }
      // Declining an expired offer is intentionally allowed — the driver
      // explicitly tapped "no thanks" on a stale UI, and recording it as
      // declined (with the reason if provided) carries more signal for
      // ops than 410 GONE. The dispatch worker only reads `offered`
      // rows so a `declined` row here is a no-op for the next tick.

      const responded = await repos.dispatchOffers.respond(
        offerId,
        'declined',
        now,
        reason ?? undefined,
      );
      if (responded === null) {
        throw new DriverError(
          'DRIVER_OFFER_ALREADY_RESPONDED',
          'offer status changed between lock and update',
          { offerId },
        );
      }
      return responded;
    });

    this.emitOfferDeclined(declined, ctx.userId, reason, now);
    return projectDispatchOffer(declined);
  }

  /**
   * Shared null + ownership check for accept/decline. Throws
   * DRIVER_OFFER_NOT_FOUND on miss, DRIVER_OFFER_NOT_YOURS on cross-driver
   * — both surface as 404 / 403 so a probing driver cannot enumerate
   * other drivers' offer ids.
   */
  private guardOfferOwnership(
    offer: DispatchOffer | null,
    offerId: string,
    ctx: DriverContext,
  ): asserts offer is DispatchOffer {
    if (offer === null) {
      throw new DriverError('DRIVER_OFFER_NOT_FOUND', `dispatch offer ${offerId} not found`, {
        offerId,
      });
    }
    if (offer.driverId !== ctx.driverId) {
      throw new DriverError(
        'DRIVER_OFFER_NOT_YOURS',
        'this offer was issued to a different driver',
        { offerId, driverId: ctx.driverId, offerDriverId: offer.driverId },
      );
    }
  }

  private emitOfferAccepted(offer: DispatchOffer, userId: string, occurredAt: Date): void {
    try {
      this.events.emit(
        OFFER_ACCEPTED_EVENT,
        new OfferAcceptedEvent({
          offerId: offer.id,
          orderId: offer.orderId,
          driverId: offer.driverId,
          userId,
          occurredAt,
        }),
      );
    } catch (err) {
      // Tx already committed — the response is durable regardless of
      // whether the realtime / notifications subscribers reacted. Log
      // and move on.
      this.logger.error(
        { offerId: offer.id, orderId: offer.orderId, err },
        'OfferAcceptedEvent subscriber threw — accept is durable, downstream side-effects may be missed',
      );
    }
  }

  private emitOfferDeclined(
    offer: DispatchOffer,
    userId: string,
    reason: string | null,
    occurredAt: Date,
  ): void {
    try {
      this.events.emit(
        OFFER_DECLINED_EVENT,
        new OfferDeclinedEvent({
          offerId: offer.id,
          orderId: offer.orderId,
          driverId: offer.driverId,
          userId,
          reason,
          occurredAt,
        }),
      );
    } catch (err) {
      this.logger.error(
        { offerId: offer.id, orderId: offer.orderId, err },
        'OfferDeclinedEvent subscriber threw — decline is durable, downstream side-effects may be missed',
      );
    }
  }
}
