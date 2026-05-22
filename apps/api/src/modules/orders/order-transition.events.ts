/**
 * Domain events emitted by the OrderTransitionService. Consumers (realtime
 * push, notifications, dispatch, metrics) subscribe via NestJS's
 * `OnEvent(ORDER_TRANSITIONED_EVENT)` decorator so cross-module side
 * effects stay event-driven — no direct service-to-service calls from
 * Orders into Realtime/Dispatch.
 *
 * Lives in `apps/api/src/modules/orders/` for now; will move into a
 * shared `packages/events` workspace in Phase 8 when the driver/dispatch
 * surface emits its own typed events.
 */
import type { OrderTransitionActor } from './order-transition.service.js';
import type { OrderEventType, OrderState } from '@dankdash/orders';

export const ORDER_TRANSITIONED_EVENT = 'order.transitioned';

export interface OrderTransitionedEventPayload {
  readonly orderId: string;
  readonly fromStatus: OrderState;
  readonly toStatus: OrderState;
  readonly event: OrderEventType;
  readonly actor: OrderTransitionActor;
  readonly occurredAt: Date;
}

export class OrderTransitionedEvent implements OrderTransitionedEventPayload {
  public readonly orderId: string;
  public readonly fromStatus: OrderState;
  public readonly toStatus: OrderState;
  public readonly event: OrderEventType;
  public readonly actor: OrderTransitionActor;
  public readonly occurredAt: Date;

  constructor(payload: OrderTransitionedEventPayload) {
    this.orderId = payload.orderId;
    this.fromStatus = payload.fromStatus;
    this.toStatus = payload.toStatus;
    this.event = payload.event;
    this.actor = payload.actor;
    this.occurredAt = payload.occurredAt;
  }
}
