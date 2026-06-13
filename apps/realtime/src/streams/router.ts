/**
 * Event-type → namespace + room routing.
 *
 * Pure function: takes a typed envelope, returns the list of `(namespace,
 * room, eventName, payload)` triples to fan out. The streams consumer
 * then walks the triples and calls io.of(ns).to(room).emit(...). Keeping
 * the routing in a pure function makes it trivially unit-testable and
 * means a routing bug is a typecheck-or-test failure, not a "did the
 * customer get the message?" production mystery.
 *
 * Routing table (mirrors PHASE 9.3 + 10.3):
 *   order:created          → /vendor[dispensary]
 *   order:status_changed   → /customer[user] + /vendor[dispensary]
 *                            (+ /driver[driver] if driver assigned)
 *                            (+ /driver broadcast `delivery:claimed` when
 *                             leaving `awaiting_driver` — open-pool pin
 *                             removal for every dasher)
 *   driver:location        → /customer[user] (the assigned customer)
 *                            (+ /vendor[dispensary] for the per-order map)
 *   offer:new              → /driver[driver]
 *   offer:expired          → /driver[driver]
 *   customer:eta_updated   → /customer[user] (only the assigned customer)
 *
 * Out-of-spec events are dropped (logged once and skipped). The schema
 * validation in decodeStreamEntry already prevents an unknown `type`
 * from reaching here, but adding a `never`-checked switch arm keeps a
 * future event-type addition honest — tsc will refuse to compile until
 * the router learns about it.
 */
import { dispensaryRoom, driverRoom, userRoom } from '../io/rooms.js';
import type { RealtimeEnvelope, RealtimeEventType } from '@dankdash/realtime-events';

export interface RoutedBroadcast {
  readonly namespace: '/customer' | '/vendor' | '/driver';
  /**
   * Target room within the namespace, or `null` for a namespace-wide
   * broadcast (every connected socket in the namespace). The consumer
   * emits to `io.of(ns).to(room)` for a room, `io.of(ns)` for null. Used
   * by the open-pool `delivery:claimed` signal, which has no single
   * recipient — every dasher must drop the pin.
   */
  readonly room: string | null;
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Wire-event names emitted to clients (so the iOS/portal teams have a
 * stable contract). Kept verbatim from the event type so the client SDK
 * can subscribe to `socket.on('order:created', ...)` without translation.
 */
const eventName: Record<RealtimeEventType, string> = {
  'order:created': 'order:created',
  'order:status_changed': 'order:status_changed',
  'driver:location': 'driver:location',
  'offer:new': 'offer:new',
  'offer:expired': 'offer:expired',
  'customer:eta_updated': 'customer:eta_updated',
};

export function routeEnvelope(envelope: RealtimeEnvelope): readonly RoutedBroadcast[] {
  const { event } = envelope;
  switch (event.type) {
    case 'order:created': {
      const p = event.payload;
      return [
        {
          namespace: '/vendor',
          room: dispensaryRoom(p.dispensaryId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
      ];
    }
    case 'order:status_changed': {
      const p = event.payload;
      const out: RoutedBroadcast[] = [
        {
          namespace: '/customer',
          room: userRoom(p.customerId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
        {
          namespace: '/vendor',
          room: dispensaryRoom(p.dispensaryId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
      ];
      if (p.driverId !== null) {
        out.push({
          namespace: '/driver',
          room: driverRoom(p.driverId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        });
      }
      // Open-pool pin removal: an order leaving `awaiting_driver` is no
      // longer claimable (a dasher won the race, or it was canceled /
      // rejected / dispatch-failed). Tell EVERY dasher to drop the pin —
      // a namespace-wide broadcast, not a per-driver room. The losing
      // claimers also self-heal via the 409 on claim + the next poll, so
      // a missed event is not fatal; this just makes the map snappy.
      if (p.fromStatus === 'awaiting_driver') {
        out.push({
          namespace: '/driver',
          room: null,
          eventName: 'delivery:claimed',
          payload: { orderId: p.orderId, envelopeId: envelope.id },
        });
      }
      return out;
    }
    case 'driver:location': {
      const p = event.payload;
      const out: RoutedBroadcast[] = [];
      // The assigned customer's "track my driver" view.
      if (p.customerId !== null) {
        out.push({
          namespace: '/customer',
          room: userRoom(p.customerId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        });
      }
      // The fulfilling dispensary's per-order delivery map (PR3). Same
      // event shape; the portal filters by orderId client-side.
      if (p.dispensaryId !== null) {
        out.push({
          namespace: '/vendor',
          room: dispensaryRoom(p.dispensaryId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        });
      }
      return out;
    }
    case 'offer:new':
    case 'offer:expired': {
      const p = event.payload;
      return [
        {
          namespace: '/driver',
          room: driverRoom(p.driverId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
      ];
    }
    case 'customer:eta_updated': {
      const p = event.payload;
      return [
        {
          namespace: '/customer',
          room: userRoom(p.customerId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
      ];
    }
    default: {
      // Exhaustiveness guard — `event` is a discriminated union, so this
      // arm reduces to `never`. A future RealtimeEvent member that the
      // router has not learned about turns into a typecheck failure
      // right here, which is the point.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
