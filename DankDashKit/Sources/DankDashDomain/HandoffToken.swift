import Foundation

/// One-shot Safari hand-off envelope returned by
/// `POST /v1/auth/checkout-handoff`. Per Apple §10.4, iOS never carries
/// the checkout surface — it opens `exchangeUrl` in
/// `SFSafariViewController` and lets `checkout-web` exchange the token
/// for a session.
///
/// `exchangeUrl` is fully qualified (composed server-side) so the iOS
/// client never templates URLs — eliminates a class of per-env host
/// typos. The token has a 5-minute TTL by default and a single
/// successful exchange invalidates it via Redis `SETNX` on the `jti`
/// claim — replaying the same token after exchange returns 401 even
/// if the JWT signature still verifies cryptographically.
public struct HandoffToken: Hashable, Sendable, Codable {
  public let token: String
  public let exchangeUrl: URL
  public let expiresAt: Date

  public init(token: String, exchangeUrl: URL, expiresAt: Date) {
    self.token = token
    self.exchangeUrl = exchangeUrl
    self.expiresAt = expiresAt
  }

  /// True iff the token is at or past its TTL relative to `now`. The
  /// `CheckoutHandoffFeature` injects a `Clock` so the check stays
  /// deterministically testable; production passes the wall clock.
  public func isExpired(asOf now: Date) -> Bool {
    expiresAt <= now
  }
}
