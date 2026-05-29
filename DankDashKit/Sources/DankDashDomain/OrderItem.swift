import Foundation

/// One line on a delivered order — mirror of `OrderItemResponse`. The
/// order's per-line snapshot is immutable: the catalog row that backed
/// the line at checkout is captured in `productSnapshot`, the unit
/// price + line subtotal are denormalized as integer cents, and the
/// cannabis / sales tax allocation is split per line so the order
/// receipt reads honestly.
///
/// `productSnapshot` is `AnyValue` because the catalog snapshot's
/// shape evolves independently of order display — adding a new
/// snapshot field (a "lab results" pill) does not break this DTO.
///
/// `thcMgTotal` / `cbdMgTotal` / `weightGramsTotal` are wire-encoded
/// as decimal strings (e.g. `"3.50"`); the network DTO layer parses
/// via `Decimal(string:)` so precision survives the wire hop. These
/// are the snapshotted per-line cannabis totals — never recomputed
/// client-side, and the server treats them as immutable post-creation.
public struct OrderItem: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let listingId: UUID
  public let productSnapshot: AnyValue
  public let quantity: Int
  public let unitPriceCents: Int
  public let lineSubtotalCents: Int
  public let thcMgTotal: Decimal
  public let cbdMgTotal: Decimal
  public let weightGramsTotal: Decimal
  public let cannabisTaxCents: Int
  public let salesTaxCents: Int
  public let createdAt: Date

  public init(
    id: UUID,
    listingId: UUID,
    productSnapshot: AnyValue,
    quantity: Int,
    unitPriceCents: Int,
    lineSubtotalCents: Int,
    thcMgTotal: Decimal,
    cbdMgTotal: Decimal,
    weightGramsTotal: Decimal,
    cannabisTaxCents: Int,
    salesTaxCents: Int,
    createdAt: Date
  ) {
    self.id = id
    self.listingId = listingId
    self.productSnapshot = productSnapshot
    self.quantity = quantity
    self.unitPriceCents = unitPriceCents
    self.lineSubtotalCents = lineSubtotalCents
    self.thcMgTotal = thcMgTotal
    self.cbdMgTotal = cbdMgTotal
    self.weightGramsTotal = weightGramsTotal
    self.cannabisTaxCents = cannabisTaxCents
    self.salesTaxCents = salesTaxCents
    self.createdAt = createdAt
  }
}
