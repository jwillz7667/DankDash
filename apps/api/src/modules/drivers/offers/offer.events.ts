/**
 * Domain events emitted by `DriverOffersService.accept` / `decline`.
 *
 * Why separate from `OrderTransitionedEvent`: the order machine fires
 * `OrderTransitionedEvent` on every status change — both DRIVER_ASSIGNED
 * (which an accept causes) and many others. Subscribers that ONLY care
 * about the offer-response edge (driver app realtime "your offer was
 * confirmed", dispatch worker's "stop offering this order, someone won
 * the race", customer push "your driver is here in your account") want
 * a tighter event so they don't have to filter on event-type + actor.
 *
 * Subscribers see these events AFTER the outer tx commits — the
 * `DriverOffersService` defers the emit until after the
 * `db.transaction(...)` resolves, same contract as
 * `OrderTransitionService.transitionWithinTx`.
 */
import type { DispatchOffer } from '@dankdash/db';

export const OFFER_ACCEPTED_EVENT = 'dispatch.offer.accepted';
export const OFFER_DECLINED_EVENT = 'dispatch.offer.declined';

export interface OfferAcceptedEventPayload {
  readonly offerId: string;
  readonly orderId: string;
  readonly driverId: string;
  readonly userId: string;
  readonly occurredAt: Date;
}

export class OfferAcceptedEvent implements OfferAcceptedEventPayload {
  public readonly offerId: string;
  public readonly orderId: string;
  public readonly driverId: string;
  public readonly userId: string;
  public readonly occurredAt: Date;

  constructor(payload: OfferAcceptedEventPayload) {
    this.offerId = payload.offerId;
    this.orderId = payload.orderId;
    this.driverId = payload.driverId;
    this.userId = payload.userId;
    this.occurredAt = payload.occurredAt;
  }
}

export interface OfferDeclinedEventPayload {
  readonly offerId: string;
  readonly orderId: string;
  readonly driverId: string;
  readonly userId: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export class OfferDeclinedEvent implements OfferDeclinedEventPayload {
  public readonly offerId: string;
  public readonly orderId: string;
  public readonly driverId: string;
  public readonly userId: string;
  public readonly reason: string | null;
  public readonly occurredAt: Date;

  constructor(payload: OfferDeclinedEventPayload) {
    this.offerId = payload.offerId;
    this.orderId = payload.orderId;
    this.driverId = payload.driverId;
    this.userId = payload.userId;
    this.reason = payload.reason;
    this.occurredAt = payload.occurredAt;
  }
}

/** Convenience type for `(payload: DispatchOffer) => DispatchOffer` factories. */
export interface OfferEventContext {
  readonly offer: DispatchOffer;
  readonly userId: string;
  readonly occurredAt: Date;
}
