import Foundation
import DankDashDomain

/// Wire shape for `CartItemResponseSchema`. Mirrors the server JSON one
/// for one — UUIDs and timestamps are decoded as strings and projected
/// to the Domain types via `toDomain()`. Numeric cents stay as `Int`
/// (the schema enforces `int4` non-negative).
public struct CartItemDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let listingId: String
  public let quantity: Int
  public let unitPriceCents: Int
  public let lineSubtotalCents: Int
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    listingId: String,
    quantity: Int,
    unitPriceCents: Int,
    lineSubtotalCents: Int,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.listingId = listingId
    self.quantity = quantity
    self.unitPriceCents = unitPriceCents
    self.lineSubtotalCents = lineSubtotalCents
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension CartItemDTO {
  /// Lossy projection into Domain `CartItem`. Returns nil on malformed
  /// UUIDs or timestamps so callers can drop a single bad row rather
  /// than failing the entire cart.
  func toDomain() -> CartItem? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedListingID = CatalogWire.parseUUID(listingId) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    return CartItem(
      id: parsedID,
      listingId: parsedListingID,
      quantity: quantity,
      unitPriceCents: unitPriceCents,
      lineSubtotalCents: lineSubtotalCents,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }
}

/// Wire shape for `CartResponseSchema` — the envelope returned by every
/// cart-mutation endpoint (`POST /v1/carts`, `POST /items`, `PATCH /items/:id`,
/// `DELETE /items/:id`) plus the read endpoint (`GET /v1/carts/:id`).
/// Decoded stringly to mirror the JSON; `toDomain()` is the only place
/// that validates UUIDs / timestamps / item rows.
public struct CartDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let userId: String
  public let dispensaryId: String
  public let items: [CartItemDTO]
  public let subtotalCents: Int
  public let expiresAt: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    userId: String,
    dispensaryId: String,
    items: [CartItemDTO],
    subtotalCents: Int,
    expiresAt: String,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.userId = userId
    self.dispensaryId = dispensaryId
    self.items = items
    self.subtotalCents = subtotalCents
    self.expiresAt = expiresAt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension CartDTO {
  /// Lossy projection into Domain `Cart`. Unlike the dispensary feed —
  /// which silently drops malformed list rows — a malformed line in
  /// *this* user's cart is a critical error (the line subtotal would
  /// vanish from the total stripe). We refuse the whole cart and let
  /// the caller surface a retry.
  func toDomain() -> Cart? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedUserID = CatalogWire.parseUUID(userId) else { return nil }
    guard let parsedDispensaryID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    guard let parsedExpires = CatalogWire.parseISO8601(expiresAt) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    var parsedItems: [CartItem] = []
    parsedItems.reserveCapacity(items.count)
    for item in items {
      guard let domain = item.toDomain() else { return nil }
      parsedItems.append(domain)
    }
    return Cart(
      id: parsedID,
      userId: parsedUserID,
      dispensaryId: parsedDispensaryID,
      items: parsedItems,
      subtotalCents: subtotalCents,
      expiresAt: parsedExpires,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }
}

/// Body for `POST /v1/carts`. The endpoint is idempotent: posting a
/// second time for the same `(userId, dispensaryId)` returns the same
/// row (with a refreshed `expiresAt`) rather than creating a duplicate.
public struct CreateCartRequestDTO: Encodable, Sendable, Equatable {
  public let dispensaryId: String

  public init(dispensaryId: UUID) {
    self.dispensaryId = dispensaryId.uuidString.lowercased()
  }
}

/// Body for `POST /v1/carts/:id/items`. The server treats an add for
/// an existing listing as an increment of the existing line.
public struct AddCartItemRequestDTO: Encodable, Sendable, Equatable {
  public let listingId: String
  public let quantity: Int

  public init(listingId: UUID, quantity: Int) {
    self.listingId = listingId.uuidString.lowercased()
    self.quantity = quantity
  }
}

/// Body for `PATCH /v1/carts/:id/items/:itemId`. `quantity: 0` removes
/// the line idempotently — the server returns the post-mutation cart
/// either way.
public struct PatchCartItemRequestDTO: Encodable, Sendable, Equatable {
  public let quantity: Int

  public init(quantity: Int) {
    self.quantity = quantity
  }
}
