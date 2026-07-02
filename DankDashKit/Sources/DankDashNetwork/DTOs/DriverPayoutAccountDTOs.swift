import Foundation

/// Wire DTOs for the driver payout bank-account surface:
///
///   POST /v1/driver/payouts/bank-account/link  -> { link }
///   GET  /v1/driver/payouts/bank-account       -> { linked }
///
/// Mirror of the backend `StartDriverBankLinkRequest/ResponseSchema` and
/// `DriverBankAccountStatusResponseSchema`. The link member reuses the shared
/// ``AeropayLinkSessionResponseDTO`` (same `{ id, hostedUrl, expiresAt }`
/// shape as the consumer link flow). The status response is a bare boolean —
/// the underlying Aeropay bank ref is Restricted and never crosses the wire.

public struct StartDriverBankLinkRequestDTO: Encodable, Sendable, Equatable {
  /// Absolute URL Aeropay redirects to once the hosted link flow completes.
  /// Bound at the composition root (see `AppEnvironment`), not by the reducer.
  public let returnUrl: String

  public init(returnUrl: String) {
    self.returnUrl = returnUrl
  }
}

public struct StartDriverBankLinkResponseDTO: Decodable, Sendable, Equatable {
  public let link: AeropayLinkSessionResponseDTO

  public init(link: AeropayLinkSessionResponseDTO) {
    self.link = link
  }
}

public struct DriverBankAccountStatusResponseDTO: Decodable, Sendable, Equatable {
  public let linked: Bool

  public init(linked: Bool) {
    self.linked = linked
  }
}
