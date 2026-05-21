import Foundation

/// Statutory per-transaction limits as evaluated by the server's
/// compliance engine. Mirror of `ValidateCartResponse.limits`.
///
/// **Server-authoritative.** The MN limits are Minn. Stat. § 342.27:
/// 56.7g flower, 8g concentrate, 800mg edible THC per transaction. The
/// iOS client receives them in the validate response and renders the
/// compliance preview against the server-supplied caps rather than
/// hardcoding the constants — a future legislative change updates one
/// place (the compliance package) and reaches every client through the
/// next validate response.
public struct ComplianceLimits: Hashable, Sendable, Codable {
  public let flowerGramsMax: Decimal
  public let concentrateGramsMax: Decimal
  public let edibleThcMgMax: Decimal

  public init(
    flowerGramsMax: Decimal,
    concentrateGramsMax: Decimal,
    edibleThcMgMax: Decimal
  ) {
    self.flowerGramsMax = flowerGramsMax
    self.concentrateGramsMax = concentrateGramsMax
    self.edibleThcMgMax = edibleThcMgMax
  }
}
