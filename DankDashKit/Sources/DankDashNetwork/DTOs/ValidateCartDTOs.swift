import Foundation
import DankDashDomain

/// Wire shape for `RuleResultSchema` — one rule's outcome. `rule` is
/// stringly typed at the wire boundary so an unknown rule name from a
/// future server release projects to nil rather than throwing during
/// decode (an old client gets a usable evaluation banner with rules it
/// understands and silently ignores the rest).
public struct RuleResultDTO: Decodable, Sendable, Equatable {
  public let rule: String
  public let passed: Bool
  public let details: AnyValue

  public init(rule: String, passed: Bool, details: AnyValue) {
    self.rule = rule
    self.passed = passed
    self.details = details
  }
}

public extension RuleResultDTO {
  func toDomain() -> RuleResult? {
    guard let parsedRule = RuleId(rawValue: rule) else { return nil }
    return RuleResult(rule: parsedRule, passed: passed, details: details)
  }
}

/// Wire shape for `ComplianceTotalsSnapshotSchema`. The server emits
/// `z.number()` (JSON numbers); Foundation decodes them as `Double`,
/// so the DTO holds `Double` and `toDomain()` reroutes through Double's
/// shortest-round-trippable string to land at an exact `Decimal`. A
/// direct `Decimal(double)` would yield e.g. 56.6999999... for a JSON
/// `56.7` because Double can't represent base-10 .7 exactly — the
/// `Decimal(string: String(double))` path uses Double's "56.7" repr
/// instead, which `Decimal(string:)` parses exact.
public struct ComplianceTotalsDTO: Decodable, Sendable, Equatable {
  public let flowerGrams: Double
  public let concentrateGrams: Double
  public let edibleThcMg: Double

  public init(flowerGrams: Double, concentrateGrams: Double, edibleThcMg: Double) {
    self.flowerGrams = flowerGrams
    self.concentrateGrams = concentrateGrams
    self.edibleThcMg = edibleThcMg
  }

  public func toDomain() -> ComplianceTotals {
    ComplianceTotals(
      flowerGrams: ValidateCartWire.decimal(from: flowerGrams),
      concentrateGrams: ValidateCartWire.decimal(from: concentrateGrams),
      edibleThcMg: ValidateCartWire.decimal(from: edibleThcMg)
    )
  }
}

/// Wire shape for `ComplianceLimitsSnapshotSchema`. Same Double →
/// Decimal precision dance as `ComplianceTotalsDTO`.
public struct ComplianceLimitsDTO: Decodable, Sendable, Equatable {
  public let flowerGramsMax: Double
  public let concentrateGramsMax: Double
  public let edibleThcMgMax: Double

  public init(flowerGramsMax: Double, concentrateGramsMax: Double, edibleThcMgMax: Double) {
    self.flowerGramsMax = flowerGramsMax
    self.concentrateGramsMax = concentrateGramsMax
    self.edibleThcMgMax = edibleThcMgMax
  }

  public func toDomain() -> ComplianceLimits {
    ComplianceLimits(
      flowerGramsMax: ValidateCartWire.decimal(from: flowerGramsMax),
      concentrateGramsMax: ValidateCartWire.decimal(from: concentrateGramsMax),
      edibleThcMgMax: ValidateCartWire.decimal(from: edibleThcMgMax)
    )
  }
}

/// Wire shape for `ValidateCartResponseSchema` — the full compliance
/// evaluation snapshot exposed by `POST /v1/carts/:id/validate`.
public struct ValidateCartResponseDTO: Decodable, Sendable, Equatable {
  public let passed: Bool
  public let rules: [RuleResultDTO]
  public let cartTotals: ComplianceTotalsDTO
  public let limits: ComplianceLimitsDTO
  public let evaluatedAt: String
  public let evaluationVersion: String

  public init(
    passed: Bool,
    rules: [RuleResultDTO],
    cartTotals: ComplianceTotalsDTO,
    limits: ComplianceLimitsDTO,
    evaluatedAt: String,
    evaluationVersion: String
  ) {
    self.passed = passed
    self.rules = rules
    self.cartTotals = cartTotals
    self.limits = limits
    self.evaluatedAt = evaluatedAt
    self.evaluationVersion = evaluationVersion
  }
}

public extension ValidateCartResponseDTO {
  /// Projects to Domain `ComplianceEvaluation`. Unknown rule names from
  /// a future server release are silently dropped (the `passed` flag
  /// is server-authoritative; the client renders the rules it knows
  /// about and trusts the overall verdict). Returns nil only on
  /// unparseable `evaluatedAt` — that field is required for the
  /// compliance preview header.
  func toDomain() -> ComplianceEvaluation? {
    guard let parsedEvaluatedAt = CatalogWire.parseISO8601(evaluatedAt) else { return nil }
    let parsedRules = rules.compactMap { $0.toDomain() }
    return ComplianceEvaluation(
      passed: passed,
      rules: parsedRules,
      cartTotals: cartTotals.toDomain(),
      limits: limits.toDomain(),
      evaluatedAt: parsedEvaluatedAt,
      evaluationVersion: evaluationVersion
    )
  }
}

/// Shared helpers for validate-shaped wire payloads.
enum ValidateCartWire {
  /// Converts a `z.number()` field (decoded as Double) into Decimal
  /// without inheriting Double's base-2 rounding. We round-trip via
  /// `String(double)` because Double's `description` is the shortest
  /// decimal that round-trips to the same Double — so a server-emitted
  /// 56.7 ends up as exactly `Decimal(string: "56.7")` rather than a
  /// 56.6999... distractor.
  static func decimal(from double: Double) -> Decimal {
    Decimal(string: String(double)) ?? Decimal(double)
  }
}
