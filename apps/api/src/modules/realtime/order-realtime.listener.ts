/**
 * Listens for `ORDER_TRANSITIONED_EVENT` and republishes each transition
 * onto the `dankdash:realtime` Redis Stream as an `order:status_changed`
 * envelope. The realtime service (apps/realtime) is the sole consumer;
 * the router there fans the envelope to `/customer`, `/vendor`, and (when
 * a driver is assigned) `/driver` namespaces — see
 * `apps/realtime/src/streams/router.ts`.
 *
 * Why a listener and not an inline call from OrderTransitionService:
 * realtime push is a cross-module side effect of the order state machine
 * — same shape as the Metrc enqueue and notifications listeners. The
 * transition owns the DB chokepoint; this listener reacts to it via the
 * in-process event bus.
 *
 * Why a separate Redis Stream and not the in-process EventEmitter alone:
 * the API is horizontally scalable (Railway can scale to N pods) and the
 * realtime service runs as its own deployment. The Stream is the only
 * cross-pod-and-cross-service channel that survives a redeploy + offers
 * at-least-once delivery (XPENDING + XCLAIM in the consumer).
 *
 * Failure mode: every publish path is wrapped in try/catch and logged.
 * The transition is already durable when this listener runs — the order
 * row + audit history committed before `emitDeferred` fired. A lost
 * realtime push is a UX degradation (the customer's iOS app polls
 * `/v1/orders/:id` on focus as a backstop), not a correctness loss.
 *
 * Idempotency: the envelope's `id` is a new uuidv7 per emit. A duplicate
 * `OrderTransitionedEvent` (in theory none, since the transition tx
 * commits exactly once) would surface as two distinct stream entries
 * with different ids — clients dedupe on `envelopeId` per the
 * realtime-events contract.
 */
import { type OrdersRepository } from '@dankdash/db';
import { type OrderState } from '@dankdash/orders';
import { publishRealtimeEvent } from '@dankdash/realtime-events';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import {
  ORDER_TRANSITIONED_EVENT,
  OrderTransitionedEvent,
} from '../orders/order-transition.events.js';

export interface OrderRealtimeListenerDeps {
  readonly redis: Redis;
  readonly orders: OrdersRepository;
  /** Override for tests; defaults to `uuidv7`. */
  readonly idGen?: () => string;
  /** Override for tests; defaults to wall-clock. */
  readonly now?: () => Date;
}

@Injectable()
export class OrderRealtimeListener {
  private readonly logger = new Logger(OrderRealtimeListener.name);
  private readonly idGen: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OrderRealtimeListenerDeps) {
    this.idGen = deps.idGen ?? ((): string => uuidv7());
    this.now = deps.now ?? ((): Date => new Date());
  }

  @OnEvent(ORDER_TRANSITIONED_EVENT, { suppressErrors: true })
  async onOrderTransitioned(event: OrderTransitionedEvent): Promise<void> {
    try {
      await this.publish(event);
    } catch (err) {
      // Defensive — every reachable error path below already logs +
      // returns, but a future `await` insertion or unforeseen ioredis
      // failure must not propagate into the unhandled-rejection log.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `realtime publish failed for order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async publish(event: OrderTransitionedEvent): Promise<void> {
    const order = await this.deps.orders.findById(event.orderId);
    if (order === null) {
      // Transition emitted for an order the repo cannot resolve — a
      // genuine "should never happen" because the transition tx
      // committed the row before this listener fires. Log loudly.
      this.logger.warn(`realtime publish: order ${event.orderId} not found post-commit; dropping`);
      return;
    }

    const streamId = await publishRealtimeEvent(this.deps.redis, {
      id: this.idGen(),
      emittedAt: this.now().toISOString(),
      source: 'api',
      event: {
        type: 'order:status_changed',
        payload: {
          orderId: order.id,
          customerId: order.userId,
          dispensaryId: order.dispensaryId,
          driverId: order.driverId,
          fromStatus: this.coerceStatus(event.fromStatus),
          toStatus: this.coerceStatus(event.toStatus),
          changedAt: event.occurredAt.toISOString(),
        },
      },
    });
    this.logger.debug(
      `realtime published order:status_changed for ${order.id} ` +
        `(${event.fromStatus} → ${event.toStatus}) as stream id ${streamId}`,
    );
  }

  /**
   * The realtime-events schema accepts an arbitrary string for status to
   * decouple the wire shape from the DB enum — but the OrderState type
   * is already a strict union, so this is identity-with-narrowing.
   * Centralised here in case a future status needs to be redacted /
   * remapped before broadcast (e.g. surfacing `id_scan_failed` as a
   * generic `failed` to the customer).
   */
  private coerceStatus(status: OrderState): string {
    return status;
  }
}
