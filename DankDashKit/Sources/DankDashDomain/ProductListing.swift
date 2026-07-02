import Foundation

/// One store's offer for a product — the per-dispensary half of a menu
/// line, resolved from `GET /v1/products/:id/listings`. Search is
/// dispensary-agnostic (a hit carries no price or stock because the same
/// product is carried by many stores at independent prices), so when a
/// product is opened from search the client fetches these and picks a
/// concrete listing before it can enqueue a cart line.
public struct ProductListing: Identifiable, Hashable, Sendable, Codable {
  public let listingId: UUID
  public let dispensaryId: UUID
  public let dispensaryName: String
  public let sku: String
  public let priceCents: Int
  public let compareAtPriceCents: Int?
  public let quantityAvailable: Int

  public init(
    listingId: UUID,
    dispensaryId: UUID,
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

  public var id: UUID { listingId }

  public var isInStock: Bool { quantityAvailable > 0 }
}
