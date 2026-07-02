import Foundation
import DankDashDomain

/// Wire shape for one `FavoriteItemSchema` arm. The server emits a
/// discriminated union (`type` = `dispensary` | `product`); exactly one of
/// `dispensary` / `product` is populated to match. Decoded stringly and
/// projected via `toDomain()`, which returns nil on a malformed / mismatched
/// row so a single bad entry is dropped rather than failing the whole feed.
public struct FavoriteItemDTO: Decodable, Sendable, Equatable {
  public let type: String
  public let favoritedAt: String
  public let dispensary: DispensaryDTO?
  public let product: MenuProductDTO?

  public init(
    type: String,
    favoritedAt: String,
    dispensary: DispensaryDTO?,
    product: MenuProductDTO?
  ) {
    self.type = type
    self.favoritedAt = favoritedAt
    self.dispensary = dispensary
    self.product = product
  }
}

public extension FavoriteItemDTO {
  func toDomain() -> FavoriteItem? {
    guard let favoritedAt = CatalogWire.parseISO8601(favoritedAt) else { return nil }
    switch type {
    case "dispensary":
      guard let dispensary = dispensary?.toDomain() else { return nil }
      return .dispensary(favoritedAt: favoritedAt, dispensary)
    case "product":
      guard let product = product?.toDomain() else { return nil }
      return .product(favoritedAt: favoritedAt, product)
    default:
      return nil
    }
  }
}

/// Paging envelope for `FavoritesResponseSchema`.
public struct FavoritesPageEnvelopeDTO: Decodable, Sendable, Equatable {
  public let limit: Int
  public let offset: Int
  public let total: Int

  public init(limit: Int, offset: Int, total: Int) {
    self.limit = limit
    self.offset = offset
    self.total = total
  }
}

/// Wire envelope for `GET /v1/me/favorites`.
public struct FavoritesResponseDTO: Decodable, Sendable, Equatable {
  public let favorites: [FavoriteItemDTO]
  public let page: FavoritesPageEnvelopeDTO

  public init(favorites: [FavoriteItemDTO], page: FavoritesPageEnvelopeDTO) {
    self.favorites = favorites
    self.page = page
  }

  /// Projects into Domain. Malformed items are dropped (compactMap) rather
  /// than failing the page — `total` still reflects the server's raw count.
  public func toDomain() -> FavoritesPage {
    FavoritesPage(
      items: favorites.compactMap { $0.toDomain() },
      limit: page.limit,
      offset: page.offset,
      total: page.total
    )
  }
}
