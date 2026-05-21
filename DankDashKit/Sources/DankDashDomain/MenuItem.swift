import Foundation

/// One line on a dispensary's menu — the (listing × product) join. The
/// listing fields are per-dispensary (the same product carried by two
/// stores has two listings, with possibly different prices and stock);
/// the product summary is denormalized inline so the iOS menu screen
/// renders without a reduce pass.
public struct MenuItem: Identifiable, Hashable, Sendable {
  public let listingId: UUID
  public let sku: String
  public let priceCents: Int
  public let compareAtPriceCents: Int?
  public let quantityAvailable: Int
  public let product: MenuProductSummary

  public init(
    listingId: UUID,
    sku: String,
    priceCents: Int,
    compareAtPriceCents: Int?,
    quantityAvailable: Int,
    product: MenuProductSummary
  ) {
    self.listingId = listingId
    self.sku = sku
    self.priceCents = priceCents
    self.compareAtPriceCents = compareAtPriceCents
    self.quantityAvailable = quantityAvailable
    self.product = product
  }

  public var id: UUID { listingId }

  public var isOnSale: Bool {
    guard let compareAtPriceCents else { return false }
    return compareAtPriceCents > priceCents
  }

  public var isInStock: Bool { quantityAvailable > 0 }
}
