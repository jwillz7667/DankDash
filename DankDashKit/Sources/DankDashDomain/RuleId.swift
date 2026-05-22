import Foundation

/// The set of compliance rules the server evaluates against a cart on
/// `POST /v1/carts/:id/validate`. Raw values are the wire contract with
/// `@dankdash/compliance` — adding a rule requires a coordinated server
/// + iOS release, which is intentional (compliance is server-authoritative
/// and a silent client divergence would break the audit trail).
///
/// `evaluation` is the sentinel the engine emits when a rule itself
/// throws (a database lookup failure, a missing reference row). Clients
/// render it as a generic "we couldn't check this" rather than a
/// per-rule message — the engine has already failed closed by setting
/// `passed = false`, so the CTA is blocked regardless.
public enum RuleId: String, Hashable, Sendable, CaseIterable, Codable {
  case age
  case kyc
  case dispensaryLicense = "dispensary_license"
  case hours
  case deliveryGeofence = "delivery_geofence"
  case perTransactionLimit = "per_transaction_limit"
  case productProvenance = "product_provenance"
  case evaluation
}
