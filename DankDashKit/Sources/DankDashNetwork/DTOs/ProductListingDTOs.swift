import Foundation
import DankDashDomain

/// Wire shape for `ProductListingResultSchema` — one store's active,
/// in-stock offer for a product. Mirrors the per-listing half of a menu
/// line plus the resolved `dispensaryName`.
public struct ProductListingResultDTO: Decodable, Sendable, Equatable {
  public let listingId: String
  public let dispensaryId: String
  public let dispensaryName: String
  public let sku: String
  public let priceCents: Int
  public let compareAtPriceCents: Int?
  public let quantityAvailable: Int

  public init(
    listingId: String,
    dispensaryId: String,
    dispensaryName: String,
    sku: String,
    priceCents: Int,
    compareAtPriceCents: Int?,
    quantityAvailable: Int
  ) {
    self.listingId = listingId
    self.dispensaryId = dispensaryId
    self.dispensaryName = dispensaryName
    self.sku = sku
    self.priceCents = priceCents
    self.compareAtPriceCents = compareAtPriceCents
    self.quantityAvailable = quantityAvailable
  }

  public func toDomain() -> ProductListing? {
    guard let parsedListingID = CatalogWire.parseUUID(listingId) else { return nil }
    guard let parsedDispensaryID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    return ProductListing(
      listingId: parsedListingID,
      dispensaryId: parsedDispensaryID,
      dispensaryName: dispensaryName,
      sku: sku,
      priceCents: priceCents,
      compareAtPriceCents: compareAtPriceCents,
      quantityAvailable: quantityAvailable
    )
  }
}

public struct ProductListingsPageDTO: Decodable, Sendable, Equatable {
  public let limit: Int
  public let offset: Int
  public let total: Int

  public init(limit: Int, offset: Int, total: Int) {
    self.limit = limit
    self.offset = offset
    self.total = total
  }
}

public struct ProductListingsResponseDTO: Decodable, Sendable, Equatable {
  public let listings: [ProductListingResultDTO]
  public let page: ProductListingsPageDTO

  public init(listings: [ProductListingResultDTO], page: ProductListingsPageDTO) {
    self.listings = listings
    self.page = page
  }

  /// Projects the wire rows into domain listings, dropping any row the
  /// server sent in a structurally invalid shape (`compactMap`) rather than
  /// failing the whole resolution — a single bad row shouldn't block a
  /// product from being added to the cart from another store.
  public func toDomain() -> [ProductListing] {
    listings.compactMap { $0.toDomain() }
  }
}
