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
 * Routing table (mirrors PHASE 9.3):
 *   order:created          → /vendor[dispensary]
 *   order:status_changed   → /customer[user] + /vendor[dispensary]
 *                            (+ /driver[driver] if driver assigned)
 *   driver:location        → /customer[user] (only the assigned customer)
 *   offer:new              → /driver[driver]
 *   offer:expired          → /driver[driver]
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
  readonly room: string;
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
      return out;
    }
    case 'driver:location': {
      const p = event.payload;
      if (p.customerId === null) return [];
      return [
        {
          namespace: '/customer',
          room: userRoom(p.customerId),
          eventName: eventName[event.type],
          payload: { ...p, envelopeId: envelope.id },
        },
      ];
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
