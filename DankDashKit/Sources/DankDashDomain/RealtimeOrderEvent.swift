import Foundation

/// Discriminated union of realtime events the consumer surface listens
/// for on the `/customer` Socket.io namespace, scoped to a single order
/// room.
///
/// Not the same as `OrderEvent`: that's the append-only event-log row.
/// `RealtimeOrderEvent` is the curated set of named events the realtime
/// service emits — some of which (status changes, driver assignment,
/// ETA bumps) are mirrored to the `order_events` table, but high-frequency
/// driver-location pings are realtime-only.
///
/// The reducer pattern-matches on the case and updates the right slice:
/// status / driver / coordinate / ETA. Unknown event names from a server
/// ahead of the client decode to nil at the parser boundary — the stream
/// stays alive and only delivers cases this client knows about.
public enum RealtimeOrderEvent: Sendable, Equatable {
  /// `order:status_changed` — order moved to a new state in the
  /// lifecycle. `occurredAt` is the server-recorded transition time.
  case statusChanged(orderId: UUID, status: OrderStatus, occurredAt: Date)

  /// `order:driver_assigned` — driver attached to the order. The driver
  /// profile carries the same shape as the `GET /v1/orders/:id` driver
  /// slice, so the reducer can swap it in directly.
  case driverAssigned(orderId: UUID, driver: DriverPublicProfile, occurredAt: Date)

  /// `driver:location` — periodic location ping. Emitted at ~1 Hz by
  /// the driver app; the reducer debounces to ~1Hz UI render. Not
  /// persisted to `order_events` (would balloon the partition).
  case driverLocation(orderId: UUID, coordinate: Coordinate, capturedAt: Date)

  /// `order:eta_updated` — updated estimated minutes-until-arrival.
  /// Server computes the ETA off the driver location + route; the
  /// client just reads it.
  case etaUpdated(orderId: UUID, etaMinutes: Int, updatedAt: Date)
}

public extension RealtimeOrderEvent {
  /// The order id the event is scoped to. Tests that fan a single
  /// stream out by order id use this; reducers don't because the
  /// stream is already filtered to one order.
  var orderId: UUID {
    switch self {
    case let .statusChanged(orderId, _, _),
         let .driverAssigned(orderId, _, _),
         let .driverLocation(orderId, _, _),
         let .etaUpdated(orderId, _, _):
      return orderId
    }
  }
}
