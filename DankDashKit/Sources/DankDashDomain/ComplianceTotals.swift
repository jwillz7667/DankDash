import Foundation

/// Roll-up of the cannabis weight + THC totals across a cart, as
/// computed by the server's compliance engine at validate-time. Mirror
/// of `ValidateCartResponse.cartTotals`.
///
/// Stored as `Decimal` to preserve precision under sums — `28 * 0.5g`
/// stays exactly `14.0` rather than drifting through Double rounding.
/// The iOS client never re-aggregates these values; they come straight
/// from the latest server response. Re-computing on-device would risk
/// the compliance preview diverging from the server's authoritative
/// answer, which is a compliance audit risk.
public struct ComplianceTotals: Hashable, Sendable, Codable {
  public let flowerGrams: Decimal
  public let concentrateGrams: Decimal
  public let edibleThcMg: Decimal

  public init(
    flowerGrams: Decimal,
    concentrateGrams: Decimal,
    edibleThcMg: Decimal
  ) {
    self.flowerGrams = flowerGrams
    self.concentrateGrams = concentrateGrams
    self.edibleThcMg = edibleThcMg
  }

  public static let zero = ComplianceTotals(
    flowerGrams: 0,
    concentrateGrams: 0,
    edibleThcMg: 0
  )
}
