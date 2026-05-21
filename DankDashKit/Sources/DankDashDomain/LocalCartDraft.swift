import Foundation

/// An in-memory accumulator of items the customer has "added to cart"
/// before the real cart write lands in Phase 18. The consumer iOS app is
/// menu-only per Apple §10.4: this draft is never POSTed to a payment
/// surface from iOS — Phase 18 promotes it to a server cart and hands
/// checkout off to `app.dankdash.com` via SFSafariViewController.
public struct LocalCartDraft: Hashable, Sendable, Codable {
  public struct Line: Identifiable, Hashable, Sendable, Codable {
    public let listingId: UUID
    public let productId: UUID
    public let productName: String
    public let brand: String
    public let priceCents: Int
    public var quantity: Int
    public let maxAvailable: Int

    public init(
      listingId: UUID,
      productId: UUID,
      productName: String,
      brand: String,
      priceCents: Int,
      quantity: Int,
      maxAvailable: Int
    ) {
      self.listingId = listingId
      self.productId = productId
      self.productName = productName
      self.brand = brand
      self.priceCents = priceCents
      self.quantity = quantity
      self.maxAvailable = maxAvailable
    }

    public var id: UUID { listingId }
    public var subtotalCents: Int { priceCents * quantity }
  }

  public var lines: [Line]

  public init(lines: [Line] = []) {
    self.lines = lines
  }

  public var isEmpty: Bool { lines.isEmpty }
  public var totalQuantity: Int { lines.reduce(0) { $0 + $1.quantity } }
  public var totalCents: Int { lines.reduce(0) { $0 + $1.subtotalCents } }

  /// Adds one unit of `line`. If a line with the same `listingId` exists,
  /// its quantity is bumped (clamped to `maxAvailable`); otherwise a new
  /// line is appended with the supplied quantity (also clamped).
  public mutating func add(_ line: Line) {
    if let index = lines.firstIndex(where: { $0.listingId == line.listingId }) {
      let next = min(lines[index].quantity + max(line.quantity, 1), lines[index].maxAvailable)
      lines[index].quantity = next
    } else {
      var copy = line
      copy.quantity = min(max(line.quantity, 1), line.maxAvailable)
      if copy.maxAvailable > 0 {
        lines.append(copy)
      }
    }
  }

  /// Sets the absolute quantity for a listing. A quantity <= 0 removes
  /// the line entirely; otherwise it's clamped to `maxAvailable`.
  public mutating func setQuantity(_ quantity: Int, for listingId: UUID) {
    guard let index = lines.firstIndex(where: { $0.listingId == listingId }) else { return }
    if quantity <= 0 {
      lines.remove(at: index)
    } else {
      lines[index].quantity = min(quantity, lines[index].maxAvailable)
    }
  }

  public mutating func remove(listingId: UUID) {
    lines.removeAll { $0.listingId == listingId }
  }

  public mutating func clear() {
    lines.removeAll()
  }
}
