/**
 * Auto-dispatch bridge: the moment an order reaches `ready_for_pickup`,
 * fire the system `DISPATCH_QUEUE` event so it advances to
 * `awaiting_driver` and becomes visible to the dispatch worker
 * (`apps/workers/src/jobs/dispatch/dispatch.job.ts`, which only scans
 * `awaiting_driver`). Without this listener the chain stalls the instant
 * a vendor marks an order ready — nothing else fires `DISPATCH_QUEUE`.
 *
 * Why a listener and not an inline call from the vendor `/ready` handler:
 * queuing for dispatch is a cross-module reaction to the order state
 * machine, the same shape as the realtime / metrc / notifications
 * listeners. The vendor's job is to mark the order ready; turning that
 * into a dispatchable job is the dispatch domain's concern, decoupled via
 * the in-process event bus. `actor.role: 'system'` is the same actor the
 * dispatch worker uses for `DISPATCH_FAILED`.
 *
 * Re-entrancy: this listener fires `DISPATCH_QUEUE` only when an order
 * *enters* `ready_for_pickup`. `DISPATCH_QUEUE` is legal only from
 * `ready_for_pickup` and moves the order to `awaiting_driver`, so the
 * follow-on `OrderTransitionedEvent` (toStatus `awaiting_driver`) hits the
 * `toStatus !== 'ready_for_pickup'` guard and is a no-op. No loop.
 *
 * Idempotency: a (theoretical) duplicate `ready_for_pickup` event would
 * find the order already at `awaiting_driver`; the second `DISPATCH_QUEUE`
 * is refused by the state machine with `ORDER_INVALID_TRANSITION`. That is
 * the expected benign outcome — logged at debug, not error — so a redelivery
 * never produces a spurious error line. Every other failure is logged at
 * error level; the triggering transition is already durable (committed
 * before `emitDeferred` fired), so a missed auto-dispatch degrades to the
 * dispatch worker's own backstop / manual intervention rather than data loss.
 */
import { OrderError } from '@dankdash/orders';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ORDER_TRANSITIONED_EVENT, OrderTransitionedEvent } from './order-transition.events.js';
import { OrderTransitionService } from './order-transition.service.js';

export interface OrderDispatchQueueListenerDeps {
  readonly transitions: OrderTransitionService;
}

@Injectable()
export class OrderDispatchQueueListener {
  private readonly logger = new Logger(OrderDispatchQueueListener.name);

  constructor(private readonly deps: OrderDispatchQueueListenerDeps) {}

  @OnEvent(ORDER_TRANSITIONED_EVENT, { suppressErrors: true })
  async onOrderTransitioned(event: OrderTransitionedEvent): Promise<void> {
    if (event.toStatus !== 'ready_for_pickup') {
      return;
    }

    try {
      await this.deps.transitions.transition({
        orderId: event.orderId,
        event: 'DISPATCH_QUEUE',
        actor: { role: 'system' },
        reason: 'auto-dispatch on ready_for_pickup',
      });
      this.logger.debug(`auto-dispatched order ${event.orderId} → awaiting_driver`);
    } catch (err) {
      if (err instanceof OrderError && err.code === 'ORDER_INVALID_TRANSITION') {
        // Benign: the order already moved past `ready_for_pickup` (a
        // duplicate event, or a concurrent STORE_CANCEL). Nothing to do.
        this.logger.debug(`auto-dispatch skipped for order ${event.orderId}: ${err.message}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `auto-dispatch failed for order ${event.orderId}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
