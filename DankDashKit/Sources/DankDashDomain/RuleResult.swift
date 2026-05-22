import Foundation

/// One rule's outcome from a compliance evaluation — single element of
/// `ValidateCartResponse.rules`.
///
/// `details` is typed `AnyValue` because the engine intentionally varies
/// the per-rule details payload by `rule`. Examples observed today:
///
///   - `deliveryGeofence` → `{ latitude, longitude, polygon: [...] }`
///   - `perTransactionLimit` → `{ flowerGramsOver: 12.3, ... }`
///   - `hours` → `{ opensAt: "2026-05-20T13:00:00Z" }`
///
/// Locking down the schema here would couple every new rule variant
/// to a wire-contract edit + coordinated release. Clients discriminate
/// on `rule` and read the keys for that variant, ignoring the rest.
public struct RuleResult: Hashable, Sendable, Codable {
  public let rule: RuleId
  public let passed: Bool
  public let details: AnyValue

  public init(rule: RuleId, passed: Bool, details: AnyValue) {
    self.rule = rule
    self.passed = passed
    self.details = details
  }
}
