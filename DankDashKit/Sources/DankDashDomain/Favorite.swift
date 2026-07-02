import Foundation

/// One entry in the consumer's saved-items feed (`GET /v1/me/favorites`).
/// The server returns a discriminated union keyed on `type`; each arm carries
/// the same card summary the discovery surfaces render, plus the instant the
/// save was made so the UI can order/label it.
public enum FavoriteItem: Identifiable, Hashable, Sendable {
  case dispensary(favoritedAt: Date, Dispensary)
  case product(favoritedAt: Date, MenuProductSummary)

  /// The saved target's id. Dispensary and product ids never collide (distinct
  /// UUIDs), so this is a stable `List` identity across the mixed feed.
  public var id: UUID {
    switch self {
    case let .dispensary(_, dispensary): return dispensary.id
    case let .product(_, product): return product.id
    }
  }

  /// When the user saved this item — the server's authoritative ordering key.
  public var favoritedAt: Date {
    switch self {
    case let .dispensary(favoritedAt, _): return favoritedAt
    case let .product(favoritedAt, _): return favoritedAt
    }
  }
}

/// A page of the favorites feed: the hydrated items plus the paging envelope.
/// `total` counts raw saves; `items` may be shorter when a saved target has
/// since gone inactive and the server dropped it from hydration.
public struct FavoritesPage: Hashable, Sendable {
  public let items: [FavoriteItem]
  public let limit: Int
  public let offset: Int
  public let total: Int

  public init(items: [FavoriteItem], limit: Int, offset: Int, total: Int) {
    self.items = items
    self.limit = limit
    self.offset = offset
    self.total = total
  }
}
