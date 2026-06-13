/**
 * Domain event emitted by CheckoutService the moment an order is durably
 * committed. Order creation is an INSERT (status `placed`), not a
 * transition through OrderTransitionService, so it never produces an
 * `ORDER_TRANSITIONED_EVENT` — without this dedicated event the realtime
 * pipeline has no new-order signal and the vendor portal's live queue
 * never lights up on a fresh order.
 *
 * Consumed by `OrderCreatedListener` (apps/api/src/modules/realtime),
 * which republishes it onto the `dankdash:realtime` Redis Stream as an
 * `order:created` envelope — the same cross-pod/cross-service channel the
 * status-change fanout uses.
 */

export const ORDER_PLACED_EVENT = 'order.placed';

export interface OrderPlacedEventPayload {
  readonly orderId: string;
  readonly customerId: string;
  readonly dispensaryId: string;
  readonly shortCode: string;
  readonly totalCents: number;
  readonly status: string;
  readonly placedAt: Date;
}

export class OrderPlacedEvent implements OrderPlacedEventPayload {
  public readonly orderId: string;
  public readonly customerId: string;
  public readonly dispensaryId: string;
  public readonly shortCode: string;
  public readonly totalCents: number;
  public readonly status: string;
  public readonly placedAt: Date;

  constructor(payload: OrderPlacedEventPayload) {
    this.orderId = payload.orderId;
    this.customerId = payload.customerId;
    this.dispensaryId = payload.dispensaryId;
    this.shortCode = payload.shortCode;
    this.totalCents = payload.totalCents;
    this.status = payload.status;
    this.placedAt = payload.placedAt;
  }
}
