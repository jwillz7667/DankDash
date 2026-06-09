import Foundation

/// A hosted Aeropay bank-link session. Returned by
/// `POST /v1/payment-methods/aeropay/link`. The client opens `hostedUrl`
/// in a Safari sheet; Aeropay redirects to the app's configured return URL
/// when the user finishes the bank-link flow, and the
/// `bank_account.linked` webhook then promotes the resulting (initially
/// `pending`) `payment_methods` row to `active`.
///
/// The session is short-lived (`expiresAt`); the iOS flow doesn't enforce
/// expiry locally — the server rejects a stale session — but the field is
/// carried so a future surface can warn before opening a dead link.
public struct AeropayLinkSession: Identifiable, Hashable, Sendable {
  public let id: String
  public let hostedUrl: URL
  public let expiresAt: Date

  public init(id: String, hostedUrl: URL, expiresAt: Date) {
    self.id = id
    self.hostedUrl = hostedUrl
    self.expiresAt = expiresAt
  }
}
