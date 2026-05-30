import Foundation

/// One row from the append-only `order_events` table, as exposed on
/// `GET /v1/orders/:id` (`events[]`) and as a derived shape on the
/// realtime `/customer` namespace (`order:status_changed`).
///
/// `payload` shape varies by `eventType`:
///   - `order_placed` / `order_accepted` / `order_prepping` carry
///     little or nothing useful (status alone is the signal).
///   - `driver_assigned` carries `{ driverId, displayName, ... }`.
///   - `eta_updated` carries `{ etaMinutes }`.
///   - `order_id_scan_passed` carries `{ scanRef }`.
///
/// Clients discriminate on `eventType` and read the keys for that
/// variant. Driver-location updates are **not** in this stream — they
/// fire at high frequency and ship over the realtime socket with a
/// dedicated slice on the tracking-screen reducer (Phase 19's driver
/// app emits them; Phase 18 hosts the consumer-side reducer surface).
///
/// The table is partitioned by month on `occurred_at` and guarded by
/// the `dankdash_block_mutation` trigger that rejects UPDATE / DELETE,
/// so the surface is read-only by construction.
public struct OrderEvent: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let orderId: UUID
  public let eventType: String
  public let actorUserId: UUID?
  public let actorRole: String?
  public let payload: AnyValue
  public let occurredAt: Date

  public init(
    id: UUID,
    orderId: UUID,
    eventType: String,
    actorUserId: UUID?,
    actorRole: String?,
    payload: AnyValue,
    occurredAt: Date
  ) {
    self.id = id
    self.orderId = orderId
    self.eventType = eventType
    self.actorUserId = actorUserId
    self.actorRole = actorRole
    self.payload = payload
    self.occurredAt = occurredAt
  }
}
