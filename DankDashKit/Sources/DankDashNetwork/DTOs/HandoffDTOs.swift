import Foundation
import DankDashDomain

/// Body for `POST /v1/auth/checkout-handoff`. The server validates that
/// both ids belong to the caller and that the cart matches the address
/// (compliance evaluator runs the geofence rule against the same
/// address combo).
public struct CheckoutHandoffRequestDTO: Encodable, Sendable, Equatable {
  public let cartId: String
  public let deliveryAddressId: String

  public init(cartId: UUID, deliveryAddressId: UUID) {
    self.cartId = cartId.uuidString.lowercased()
    self.deliveryAddressId = deliveryAddressId.uuidString.lowercased()
  }
}

/// Response shape — mirror of `CheckoutHandoffResponseSchema`. The
/// `exchangeUrl` is fully qualified server-side (the iOS client never
/// templates URLs — eliminates per-env host typos). The token is
/// single-shot: the second exchange of the same `jti` returns 401 even
/// if the JWT signature still verifies, so an iOS bug that resubmits
/// the same Safari load cannot replay the checkout.
public struct CheckoutHandoffResponseDTO: Decodable, Sendable, Equatable {
  public let handoffToken: String
  public let exchangeUrl: String
  public let expiresAt: String

  public init(handoffToken: String, exchangeUrl: String, expiresAt: String) {
    self.handoffToken = handoffToken
    self.exchangeUrl = exchangeUrl
    self.expiresAt = expiresAt
  }
}

public extension CheckoutHandoffResponseDTO {
  /// Lossy projection — returns nil on a malformed URL or unparseable
  /// expiry. The caller surfaces the failure as "checkout temporarily
  /// unavailable, try again" rather than handing Safari a bad URL.
  func toDomain() -> HandoffToken? {
    guard let parsedURL = URL(string: exchangeUrl) else { return nil }
    guard let parsedExpiresAt = CatalogWire.parseISO8601(expiresAt) else { return nil }
    return HandoffToken(
      token: handoffToken,
      exchangeUrl: parsedURL,
      expiresAt: parsedExpiresAt
    )
  }
}
