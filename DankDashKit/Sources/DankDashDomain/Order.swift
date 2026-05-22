import Foundation

/// A placed delivery order — mirror of `OrderResponse` (returned by
/// `POST /v1/carts/:id/checkout` and `GET /v1/orders/:id`).
///
/// Money is integer cents (matches the `orders_total_matches` CHECK
/// constraint in the schema); timestamps are RFC 3339 with offset. The
/// invariant `totalCents == subtotalCents + cannabisTaxCents +
/// salesTaxCents + deliveryFeeCents + driverTipCents - discountCents`
/// is enforced server-side, so the client just reads `totalCents`
/// directly rather than re-computing.
///
/// `status` is the current state in the 19-state lifecycle; `items[]`
/// is the immutable per-line snapshot taken at checkout. The order's
/// real-time evolution comes via the `/customer` realtime namespace
/// (`order:status_changed`) plus periodic re-fetches of this projection.
public struct Order: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let shortCode: String
  public let userId: UUID
  public let dispensaryId: UUID
  public let deliveryAddressId: UUID
  public let status: OrderStatus
  public let subtotalCents: Int
  public let cannabisTaxCents: Int
  public let salesTaxCents: Int
  public let deliveryFeeCents: Int
  public let driverTipCents: Int
  public let discountCents: Int
  public let totalCents: Int
  public let items: [OrderItem]
  public let placedAt: Date
  public let statusChangedAt: Date
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    shortCode: String,
    userId: UUID,
    dispensaryId: UUID,
    deliveryAddressId: UUID,
    status: OrderStatus,
    subtotalCents: Int,
    cannabisTaxCents: Int,
    salesTaxCents: Int,
    deliveryFeeCents: Int,
    driverTipCents: Int,
    discountCents: Int,
    totalCents: Int,
    items: [OrderItem],
    placedAt: Date,
    statusChangedAt: Date,
    createdAt: Date,
    updatedAt: Date
  ) {
    self.id = id
    self.shortCode = shortCode
    self.userId = userId
    self.dispensaryId = dispensaryId
    self.deliveryAddressId = deliveryAddressId
    self.status = status
    self.subtotalCents = subtotalCents
    self.cannabisTaxCents = cannabisTaxCents
    self.salesTaxCents = salesTaxCents
    self.deliveryFeeCents = deliveryFeeCents
    self.driverTipCents = driverTipCents
    self.discountCents = discountCents
    self.totalCents = totalCents
    self.items = items
    self.placedAt = placedAt
    self.statusChangedAt = statusChangedAt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

/// Slim projection returned by `GET /v1/orders` — the Orders tab list
/// rows. Drops `items[]`, the compliance snapshot, and the event log
/// (those load on demand via `GET /v1/orders/:id`). Keeps everything
/// the row card renders: short code, dispensary id (the client joins
/// against its dispensary cache for the brand), status, total cents,
/// `placedAt`, `statusChangedAt`. Slim payload keeps the Orders tab
/// snappy even with hundreds of historic orders.
public struct OrderListItem: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let shortCode: String
  public let dispensaryId: UUID
  public let status: OrderStatus
  public let totalCents: Int
  public let placedAt: Date
  public let statusChangedAt: Date

  public init(
    id: UUID,
    shortCode: String,
    dispensaryId: UUID,
    status: OrderStatus,
    totalCents: Int,
    placedAt: Date,
    statusChangedAt: Date
  ) {
    self.id = id
    self.shortCode = shortCode
    self.dispensaryId = dispensaryId
    self.status = status
    self.totalCents = totalCents
    self.placedAt = placedAt
    self.statusChangedAt = statusChangedAt
  }
}
