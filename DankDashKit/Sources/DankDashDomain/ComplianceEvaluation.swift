import Foundation

/// Full compliance evaluation snapshot — the response shape of
/// `POST /v1/carts/:id/validate` and the JSONB blob persisted as
/// `orders.compliance_check_payload` at checkout. The iOS cart screen
/// renders the entire compliance preview off this single value.
///
/// `passed` reflects the AND of every rule in `rules`. The iOS client
/// gates the "Continue to checkout" CTA on `passed`; the per-rule
/// `RuleResult` array drives granular error UI ("we couldn't verify
/// your address falls inside the dispensary's delivery zone").
///
/// `evaluationVersion` is the engine's release tag at the moment of
/// evaluation. iOS stamps it onto any later support diagnostics — when
/// a customer reports "the app said I was good but checkout failed",
/// the version tells back-end support which rule set actually ran.
public struct ComplianceEvaluation: Hashable, Sendable, Codable {
  public let passed: Bool
  public let rules: [RuleResult]
  public let cartTotals: ComplianceTotals
  public let limits: ComplianceLimits
  public let evaluatedAt: Date
  public let evaluationVersion: String

  public init(
    passed: Bool,
    rules: [RuleResult],
    cartTotals: ComplianceTotals,
    limits: ComplianceLimits,
    evaluatedAt: Date,
    evaluationVersion: String
  ) {
    self.passed = passed
    self.rules = rules
    self.cartTotals = cartTotals
    self.limits = limits
    self.evaluatedAt = evaluatedAt
    self.evaluationVersion = evaluationVersion
  }

  /// Lookup convenience for "what did the engine say about this
  /// specific rule?" — returns the first match (rule ids are unique in
  /// a response) or `nil` if the engine didn't evaluate it (defensive
  /// in case the server enum drifts ahead of the client).
  public func result(for rule: RuleId) -> RuleResult? {
    rules.first { $0.rule == rule }
  }

  public var failedRules: [RuleResult] {
    rules.filter { !$0.passed }
  }
}
