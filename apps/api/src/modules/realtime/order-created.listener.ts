/**
 * Listens for `ORDER_PLACED_EVENT` and republishes each freshly committed
 * order onto the `dankdash:realtime` Redis Stream as an `order:created`
 * envelope. The realtime service (apps/realtime) fans it to the
 * `/vendor` dispensary room so the portal's live queue inserts the card
 * and chimes the new-order alert — see `apps/realtime/src/streams/router.ts`.
 *
 * Sibling of `OrderRealtimeListener` (which handles status transitions).
 * Separate event because order creation is an INSERT, not a transition:
 * the status-change listener only ever sees orders that move *between*
 * states, never the initial `placed` write.
 *
 * Unlike the status listener this needs no DB lookup — the event payload
 * carries every field `orderCreatedPayloadSchema` requires, captured
 * inside the checkout transaction before it committed.
 *
 * Failure mode: the publish is wrapped in try/catch and logged. The order
 * row is already durable when this fires (emitted post-commit), so a lost
 * push is a UX degradation — the portal's polling fallback still surfaces
 * the order within ~15s — not a correctness loss.
 */
import { publishRealtimeEvent } from '@dankdash/realtime-events';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { ORDER_PLACED_EVENT, OrderPlacedEvent } from '../orders/order-placed.events.js';

export interface OrderCreatedListenerDeps {
  readonly redis: Redis;
  /** Override for tests; defaults to `uuidv7`. */
  readonly idGen?: () => string;
  /** Override for tests; defaults to wall-clock. */
  readonly now?: () => Date;
}

@Injectable()
export class OrderCreatedListener {
  private readonly logger = new Logger(OrderCreatedListener.name);
  private readonly idGen: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OrderCreatedListenerDeps) {
    this.idGen = deps.idGen ?? ((): string => uuidv7());
    this.now = deps.now ?? ((): Date => new Date());
  }

  @OnEvent(ORDER_PLACED_EVENT, { suppressErrors: true })
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    try {
      const streamId = await publishRealtimeEvent(this.deps.redis, {
        id: this.idGen(),
        emittedAt: this.now().toISOString(),
        source: 'api',
        event: {
          type: 'order:created',
          payload: {
            orderId: event.orderId,
            customerId: event.customerId,
            dispensaryId: event.dispensaryId,
            shortCode: event.shortCode,
            totalCents: event.totalCents,
            status: event.status,
            placedAt: event.placedAt.toISOString(),
          },
        },
      });
      this.logger.debug(
        `realtime published order:created for ${event.orderId} ` +
          `(${event.shortCode}) as stream id ${streamId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `realtime publish failed for new order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
